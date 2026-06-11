//+------------------------------------------------------------------+
//| TheAutoTraderExecutor.mq5                                        |
//|                                                                  |
//| Polls /ea/poll, executes commands, reports results, pushes state.|
//| No trading decisions — pure hands, not brains.                   |
//+------------------------------------------------------------------+
#property copyright "TheAutoTrader"
#property version   "1.00"
#property description "EA Executor — polls backend, executes commands, pushes state."

#include <Trade/Trade.mqh>

//+------------------------------------------------------------------+
//| Inputs                                                           |
//+------------------------------------------------------------------+
input string BackendURL       = "https://<railway-app>";  // no trailing slash
input string TerminalToken    = "";                        // X-Terminal-Token value
input int    PollIntervalMs   = 500;
input int    StateIntervalMs  = 1500;
input long   MagicNumber      = 770001;
input double MaxLotsPerCmd    = 1.0;   // hard cap — reject above
input int    MaxOpenPositions = 20;    // refuse new opens beyond this
input bool   DryRun           = true;  // DEFAULT TRUE — logs instead of trading

//+------------------------------------------------------------------+
//| Constants                                                        |
//+------------------------------------------------------------------+
#define IDEMPOTENCY_FILE    "att_processed_ids.txt"
#define MAX_PROCESSED_IDS   500
#define HTTP_TIMEOUT_MS     10000

//+------------------------------------------------------------------+
//| Globals                                                          |
//+------------------------------------------------------------------+
CTrade   g_trade;
string   g_processed_ids[];      // in-memory list of handled command IDs
datetime g_last_state_push  = 0;
datetime g_last_http_fail   = 0;
int      g_backoff_idx      = 0; // 0=ok  1=1s  2=2s  3=5s
int      g_backoff_logged   = -1;
bool     g_url_ok           = false;
datetime g_last_nourl_warn  = 0;

static const int BACKOFF_SECS[3] = {1, 2, 5};

//+------------------------------------------------------------------+
//| JSON — escape a string value                                     |
//+------------------------------------------------------------------+
string JEsc(const string s)
  {
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   StringReplace(r, "\n", "\\n");
   StringReplace(r, "\r", "\\r");
   StringReplace(r, "\t", "\\t");
   return r;
  }

//+------------------------------------------------------------------+
//| JSON — extract a string value by key (shallow, first match)     |
//+------------------------------------------------------------------+
string JStr(const string json, const string key, const string def = "")
  {
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return def;
   p += StringLen(pat);
   int len = StringLen(json);
   while(p < len)
     {
      ushort c = StringGetCharacter(json, p);
      if(c == ':' || c == ' ' || c == '\t') p++;
      else break;
     }
   if(p >= len) return def;
   // quoted string
   if(StringGetCharacter(json, p) == '"')
     {
      p++;
      string result = "";
      while(p < len)
        {
         ushort c = StringGetCharacter(json, p++);
         if(c == '\\' && p < len)
           {
            ushort e = StringGetCharacter(json, p++);
            if(e == 'n') result += "\n";
            else if(e == 't') result += "\t";
            else if(e == 'r') result += "\r";
            else result += ShortToString(e);
           }
         else if(c == '"') break;
         else result += ShortToString(c);
        }
      return result;
     }
   // bare numeric token — accept digits, sign, dot so positionId:123 works
   ushort first = StringGetCharacter(json, p);
   if((first >= '0' && first <= '9') || first == '-')
     {
      string num = "";
      while(p < len)
        {
         ushort c = StringGetCharacter(json, p);
         if((c >= '0' && c <= '9') || c == '-' || c == '.' || c == 'e' || c == 'E' || c == '+')
           { num += ShortToString(c); p++; }
         else break;
        }
      return num;
     }
   return def;
  }

//+------------------------------------------------------------------+
//| JSON — extract a numeric value by key                           |
//+------------------------------------------------------------------+
double JNum(const string json, const string key, const double def = 0.0)
  {
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return def;
   p += StringLen(pat);
   int len = StringLen(json);
   while(p < len)
     {
      ushort c = StringGetCharacter(json, p);
      if(c == ':' || c == ' ' || c == '\t') p++;
      else break;
     }
   if(p >= len) return def;
   ushort first = StringGetCharacter(json, p);
   if(first == '"' || first == 'n' || first == 't' || first == 'f') return def;
   string num = "";
   while(p < len)
     {
      ushort c = StringGetCharacter(json, p);
      if((c >= '0' && c <= '9') || c == '-' || c == '.' || c == 'e' || c == 'E' || c == '+')
        { num += ShortToString(c); p++; }
      else break;
     }
   return StringLen(num) > 0 ? StringToDouble(num) : def;
  }

//+------------------------------------------------------------------+
//| JSON — extract a nested object by key, returns "{...}"          |
//+------------------------------------------------------------------+
string JObj(const string json, const string key)
  {
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return "";
   p += StringLen(pat);
   int len = StringLen(json);
   while(p < len && StringGetCharacter(json, p) != '{') p++;
   if(p >= len) return "";
   int depth = 0, start = p;
   while(p < len)
     {
      ushort c = StringGetCharacter(json, p++);
      if(c == '{') depth++;
      else if(c == '}') { depth--; if(depth == 0) return StringSubstr(json, start, p - start); }
     }
   return "";
  }

//+------------------------------------------------------------------+
//| JSON — split the "commands" array into individual object strings |
//+------------------------------------------------------------------+
int SplitCommands(const string response, string &cmds[])
  {
   int start = StringFind(response, "\"commands\"");
   if(start < 0) return 0;
   start += 10; // len("\"commands\"")
   int len = StringLen(response);
   while(start < len && StringGetCharacter(response, start) != '[') start++;
   if(start >= len) return 0;
   start++;

   int count = 0, depth = 0, obj_start = -1;
   for(int i = start; i < len; i++)
     {
      ushort c = StringGetCharacter(response, i);
      if(c == '{')
        {
         if(depth == 0) obj_start = i;
         depth++;
        }
      else if(c == '}')
        {
         depth--;
         if(depth == 0 && obj_start >= 0)
           {
            ArrayResize(cmds, count + 1);
            cmds[count++] = StringSubstr(response, obj_start, i - obj_start + 1);
            obj_start = -1;
           }
        }
      else if(c == ']' && depth == 0) break;
     }
   return count;
  }

//+------------------------------------------------------------------+
//| ISO 8601 UTC timestamp                                           |
//+------------------------------------------------------------------+
string FormatISO8601(datetime dt)
  {
   MqlDateTime m;
   TimeToStruct(dt, m);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
                       m.year, m.mon, m.day, m.hour, m.min, m.sec);
  }

//+------------------------------------------------------------------+
//| HTTP — send request; returns body; http_code = -1 on net error  |
//+------------------------------------------------------------------+
string HttpReq(const string method, const string path, const string body, int &http_code)
  {
   string url  = BackendURL + path;
   string hdrs = "X-Terminal-Token: " + TerminalToken + "\r\nContent-Type: application/json\r\n";
   char   data_arr[];
   char   result_arr[];
   string resp_hdrs;

   if(StringLen(body) > 0)
     {
      int n = StringToCharArray(body, data_arr, 0, WHOLE_ARRAY, CP_UTF8);
      if(n > 1) ArrayResize(data_arr, n - 1); // strip null terminator
     }

   http_code = WebRequest(method, url, hdrs, HTTP_TIMEOUT_MS, data_arr, result_arr, resp_hdrs);
   if(http_code == -1) return "";
   return CharArrayToString(result_arr, 0, WHOLE_ARRAY, CP_UTF8);
  }

//+------------------------------------------------------------------+
//| Backoff — returns true if we should skip this cycle             |
//+------------------------------------------------------------------+
bool InBackoff()
  {
   if(g_backoff_idx == 0) return false;
   return (TimeGMT() - g_last_http_fail) < BACKOFF_SECS[g_backoff_idx - 1];
  }

void OnHttpOk()
  {
   if(g_backoff_idx > 0)
     {
      Print("[executor] HTTP recovered — resuming normal operation");
      g_backoff_idx    = 0;
      g_backoff_logged = 0;
      g_url_ok         = true;
     }
  }

void OnHttpFail(const string ctx)
  {
   g_last_http_fail = TimeGMT();
   if(g_backoff_idx < 3) g_backoff_idx++;
   if(g_backoff_idx != g_backoff_logged)
     {
      g_backoff_logged = g_backoff_idx;
      Print("[executor] HTTP failure (", ctx, ") — backoff ",
            BACKOFF_SECS[g_backoff_idx - 1], "s (level ", g_backoff_idx, "/3)");
     }
  }

//+------------------------------------------------------------------+
//| POST result to /ea/result; returns true on 2xx                  |
//+------------------------------------------------------------------+
bool PostResult(const string cmd_id,
                const bool   ok,
                const string retcode,
                const string deal_ticket,
                const double fill_price,
                const string message)
  {
   string body = "{\"commandId\":\"" + JEsc(cmd_id) + "\""
                 + ",\"ok\":"         + (ok ? "true" : "false")
                 + ",\"retcode\":\""  + JEsc(retcode) + "\"";
   if(StringLen(deal_ticket) > 0)
      body += ",\"dealTicket\":\"" + JEsc(deal_ticket) + "\"";
   if(fill_price > 0.0)
      body += ",\"fillPrice\":"    + DoubleToString(fill_price, 5);
   if(StringLen(message) > 0)
      body += ",\"message\":\""    + JEsc(message) + "\"";
   body += "}";

   int code;
   HttpReq("POST", "/ea/result", body, code);
   bool success = (code >= 200 && code <= 299);
   if(!success)
      Print("[executor] WARNING: result POST failed id=", cmd_id, " http=", code);
   return success;
  }

//+------------------------------------------------------------------+
//| Idempotency — load IDs from file on init                        |
//+------------------------------------------------------------------+
void LoadProcessedIds()
  {
   ArrayResize(g_processed_ids, 0);
   int fh = FileOpen(IDEMPOTENCY_FILE, FILE_READ | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE) return;

   string all[];
   int n = 0;
   while(!FileIsEnding(fh))
     {
      string line = StringTrimRight(StringTrimLeft(FileReadString(fh)));
      if(StringLen(line) > 10)
        {
         ArrayResize(all, n + 1);
         all[n++] = line;
        }
     }
   FileClose(fh);

   int start = MathMax(0, n - MAX_PROCESSED_IDS);
   int keep  = n - start;
   ArrayResize(g_processed_ids, keep);
   for(int i = 0; i < keep; i++)
      g_processed_ids[i] = all[start + i];

   Print("[executor] Loaded ", keep, " processed IDs from idempotency file");
  }

//+------------------------------------------------------------------+
//| Idempotency — check                                             |
//+------------------------------------------------------------------+
bool IsProcessed(const string id)
  {
   int n = ArraySize(g_processed_ids);
   for(int i = 0; i < n; i++)
      if(g_processed_ids[i] == id) return true;
   return false;
  }

//+------------------------------------------------------------------+
//| Idempotency — mark and persist (call ONLY after result POST ok) |
//+------------------------------------------------------------------+
void MarkProcessed(const string id)
  {
   int n = ArraySize(g_processed_ids);
   ArrayResize(g_processed_ids, n + 1);
   g_processed_ids[n] = id;

   if(n + 1 > MAX_PROCESSED_IDS)
     {
      int excess = (n + 1) - MAX_PROCESSED_IDS;
      for(int i = 0; i < MAX_PROCESSED_IDS; i++)
         g_processed_ids[i] = g_processed_ids[i + excess];
      ArrayResize(g_processed_ids, MAX_PROCESSED_IDS);
     }

   int fh = FileOpen(IDEMPOTENCY_FILE, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
     {
      Print("[executor] WARNING: cannot write idempotency file");
      return;
     }
   int count = ArraySize(g_processed_ids);
   for(int i = 0; i < count; i++)
      FileWriteString(fh, g_processed_ids[i] + "\n");
   FileClose(fh);
  }

//+------------------------------------------------------------------+
//| Filling mode — pick best supported mode for a symbol            |
//+------------------------------------------------------------------+
ENUM_ORDER_TYPE_FILLING BestFilling(const string symbol)
  {
   int flags = (int)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((flags & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   if((flags & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
  }

//+------------------------------------------------------------------+
//| Build /ea/state JSON body                                        |
//+------------------------------------------------------------------+
string BuildStateJson()
  {
   // --- positions ---
   string pos_arr = "";
   int total_pos = PositionsTotal();
   for(int i = 0; i < total_pos; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      string sym    = PositionGetString(POSITION_SYMBOL);
      long   ptype  = PositionGetInteger(POSITION_TYPE);
      double vol    = PositionGetDouble(POSITION_VOLUME);
      double open_p = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl     = PositionGetDouble(POSITION_SL);
      double tp     = PositionGetDouble(POSITION_TP);
      double profit = PositionGetDouble(POSITION_PROFIT);
      long   magic  = PositionGetInteger(POSITION_MAGIC);
      string cmt    = PositionGetString(POSITION_COMMENT);
      string tstr   = (ptype == POSITION_TYPE_BUY) ? "buy" : "sell";

      if(StringLen(pos_arr) > 0) pos_arr += ",";
      pos_arr += "{"
                 + "\"ticket\":"    + IntegerToString((long)ticket)
                 + ",\"symbol\":\"" + JEsc(sym)   + "\""
                 + ",\"type\":\""   + tstr          + "\""
                 + ",\"lots\":"     + DoubleToString(vol,    2)
                 + ",\"openPrice\":" + DoubleToString(open_p, 5)
                 + ",\"sl\":"       + DoubleToString(sl,     5)
                 + ",\"tp\":"       + DoubleToString(tp,     5)
                 + ",\"profit\":"   + DoubleToString(profit, 2)
                 + ",\"magic\":"    + IntegerToString(magic)
                 + ",\"comment\":\"" + JEsc(cmt) + "\""
                 + "}";
     }

   // --- orders ---
   string ord_arr = "";
   int total_ord = OrdersTotal();
   for(int i = 0; i < total_ord; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;

      long   otype  = OrderGetInteger(ORDER_TYPE);
      string tstr;
      if     (otype == ORDER_TYPE_BUY_LIMIT)  tstr = "buy_limit";
      else if(otype == ORDER_TYPE_SELL_LIMIT)  tstr = "sell_limit";
      else if(otype == ORDER_TYPE_BUY_STOP)    tstr = "buy_stop";
      else if(otype == ORDER_TYPE_SELL_STOP)   tstr = "sell_stop";
      else continue;

      string sym    = OrderGetString(ORDER_SYMBOL);
      double vol    = OrderGetDouble(ORDER_VOLUME_CURRENT);
      double open_p = OrderGetDouble(ORDER_PRICE_OPEN);
      double sl     = OrderGetDouble(ORDER_SL);
      double tp     = OrderGetDouble(ORDER_TP);
      long   magic  = OrderGetInteger(ORDER_MAGIC);
      string cmt    = OrderGetString(ORDER_COMMENT);

      if(StringLen(ord_arr) > 0) ord_arr += ",";
      ord_arr += "{"
                 + "\"ticket\":"    + IntegerToString((long)ticket)
                 + ",\"symbol\":\"" + JEsc(sym)   + "\""
                 + ",\"type\":\""   + tstr          + "\""
                 + ",\"lots\":"     + DoubleToString(vol,    2)
                 + ",\"openPrice\":" + DoubleToString(open_p, 5)
                 + ",\"sl\":"       + DoubleToString(sl,     5)
                 + ",\"tp\":"       + DoubleToString(tp,     5)
                 + ",\"magic\":"    + IntegerToString(magic)
                 + ",\"comment\":\"" + JEsc(cmt) + "\""
                 + "}";
     }

   // --- account ---
   double balance    = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity     = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin_free = AccountInfoDouble(ACCOUNT_MARGIN_FREE);

   return "{"
          + "\"positions\":["  + pos_arr  + "]"
          + ",\"orders\":["    + ord_arr  + "]"
          + ",\"account\":{"
          + "\"balance\":"    + DoubleToString(balance,     2)
          + ",\"equity\":"    + DoubleToString(equity,      2)
          + ",\"marginFree\":" + DoubleToString(margin_free, 2)
          + "}"
          + ",\"terminalTime\":\"" + FormatISO8601(TimeGMT()) + "\""
          + "}";
  }

//+------------------------------------------------------------------+
//| Push state; returns true on 2xx                                  |
//+------------------------------------------------------------------+
bool PushState()
  {
   int code;
   HttpReq("POST", "/ea/state", BuildStateJson(), code);
   bool ok = (code >= 200 && code <= 299);
   if(ok)
     {
      OnHttpOk();
      g_last_state_push = TimeGMT();
     }
   else OnHttpFail("/ea/state");
   return ok;
  }

//+------------------------------------------------------------------+
//| Execute a single command                                         |
//| Returns true when a result was posted (regardless of ok/fail).  |
//+------------------------------------------------------------------+
bool ExecuteCommand(const string cmd_id, const string cmd_type, const string payload)
  {
   Print("[executor] command received id=", cmd_id, " type=", cmd_type);

   // --- gate: duplicate ---
   if(IsProcessed(cmd_id))
     {
      Print("[executor] DUPLICATE id=", cmd_id, " — skipping");
      PostResult(cmd_id, false, "DUPLICATE", "", 0, "command id already processed");
      return true;
      // no MarkProcessed — already in file
     }

   // --- gate: EA_HALT ---
   if(GlobalVariableCheck("EA_HALT") && GlobalVariableGet("EA_HALT") != 0)
     {
      Print("[executor] HALTED — rejecting id=", cmd_id);
      bool posted = PostResult(cmd_id, false, "HALTED", "", 0, "halted");
      if(posted) MarkProcessed(cmd_id);
      return true;
     }

   // --- gate: dry-run ---
   if(DryRun)
     {
      Print("[executor] DRY_RUN — would execute type=", cmd_type, " payload=", payload);
      bool posted = PostResult(cmd_id, false, "DRY_RUN", "", 0, "dry-run mode");
      if(posted) MarkProcessed(cmd_id);
      return true;
     }

   // --- gate: lot cap (place + close_partial) ---
   double req_vol = JNum(payload, "volume");
   bool is_vol_cmd = (cmd_type == "place_market" || cmd_type == "place_limit" || cmd_type == "close_partial");
   if(is_vol_cmd && req_vol > MaxLotsPerCmd)
     {
      Print("[executor] LOT_CAP volume=", req_vol, " > ", MaxLotsPerCmd, " id=", cmd_id);
      bool posted = PostResult(cmd_id, false, "LOT_CAP", "", 0, "lot cap exceeded");
      if(posted) MarkProcessed(cmd_id);
      return true;
     }

   // --- gate: position cap (new opens only) ---
   if((cmd_type == "place_market" || cmd_type == "place_limit") &&
      PositionsTotal() >= MaxOpenPositions)
     {
      Print("[executor] POS_CAP positions=", PositionsTotal(), " id=", cmd_id);
      bool posted = PostResult(cmd_id, false, "POS_CAP", "", 0, "position cap");
      if(posted) MarkProcessed(cmd_id);
      return true;
     }

   // ---- execute ----
   bool   ok          = false;
   string retcode_str = "";
   string deal_ticket = "";
   double fill_price  = 0.0;
   string message     = "";

   if(cmd_type == "place_market")
     {
      string dir  = JStr(payload, "direction");
      string sym  = JStr(payload, "symbol");
      double vol  = JNum(payload, "volume");
      double sl   = JNum(payload, "sl");
      double tp   = JNum(payload, "tp");
      string cmt  = JStr(payload, "comment");

      g_trade.SetExpertMagicNumber((ulong)MagicNumber);
      g_trade.SetTypeFilling(BestFilling(sym));

      bool res = (dir == "buy")
                 ? g_trade.Buy(vol, sym, 0, sl, tp, cmt)
                 : g_trade.Sell(vol, sym, 0, sl, tp, cmt);

      ok          = res;
      retcode_str = IntegerToString((long)g_trade.ResultRetcode());
      ulong deal  = g_trade.ResultDeal();
      ulong ord   = g_trade.ResultOrder();
      deal_ticket = (deal > 0) ? IntegerToString((long)deal) : (ord > 0 ? IntegerToString((long)ord) : "");
      fill_price  = g_trade.ResultPrice();
      message     = g_trade.ResultRetcodeDescription();
     }
   else if(cmd_type == "place_limit")
     {
      string dir       = JStr(payload, "direction");
      string sym       = JStr(payload, "symbol");
      double vol       = JNum(payload, "volume");
      double open_price = JNum(payload, "openPrice");
      double sl        = JNum(payload, "sl");
      double tp        = JNum(payload, "tp");
      string cmt       = JStr(payload, "comment");

      g_trade.SetExpertMagicNumber((ulong)MagicNumber);
      g_trade.SetTypeFilling(ORDER_FILLING_RETURN);

      bool res = (dir == "buy")
                 ? g_trade.BuyLimit(vol, open_price, sym, sl, tp, ORDER_TIME_GTC, 0, cmt)
                 : g_trade.SellLimit(vol, open_price, sym, sl, tp, ORDER_TIME_GTC, 0, cmt);

      ok          = res;
      retcode_str = IntegerToString((long)g_trade.ResultRetcode());
      ulong ord   = g_trade.ResultOrder();
      deal_ticket = (ord > 0) ? IntegerToString((long)ord) : "";
      fill_price  = g_trade.ResultPrice();
      message     = g_trade.ResultRetcodeDescription();
     }
   else if(cmd_type == "modify_sl_tp")
     {
      string pos_id = JStr(payload, "positionId");
      ulong  ticket = (ulong)StringToInteger(pos_id);
      double sl     = JNum(payload, "stopLoss");
      double tp     = JNum(payload, "takeProfit");

      if(!PositionSelectByTicket(ticket))
        {
         Print("[executor] modify_sl_tp: position ", ticket, " not found id=", cmd_id);
         bool posted = PostResult(cmd_id, false, "NOT_FOUND", "", 0, "position not found");
         if(posted) MarkProcessed(cmd_id);
         return true;
        }
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
        {
         Print("[executor] MAGIC_MISMATCH ticket=", ticket, " id=", cmd_id);
         bool posted = PostResult(cmd_id, false, "MAGIC_MISMATCH", "", 0, "magic mismatch — not my position");
         if(posted) MarkProcessed(cmd_id);
         return true;
        }

      bool res    = g_trade.PositionModify(ticket, sl, tp);
      ok          = res;
      retcode_str = IntegerToString((long)g_trade.ResultRetcode());
      message     = g_trade.ResultRetcodeDescription();
     }
   else if(cmd_type == "close_partial")
     {
      string pos_id = JStr(payload, "positionId");
      ulong  ticket = (ulong)StringToInteger(pos_id);
      double vol    = JNum(payload, "volume");

      if(!PositionSelectByTicket(ticket))
        {
         Print("[executor] close_partial: position ", ticket, " not found id=", cmd_id);
         bool posted = PostResult(cmd_id, false, "NOT_FOUND", "", 0, "position not found");
         if(posted) MarkProcessed(cmd_id);
         return true;
        }
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
        {
         Print("[executor] MAGIC_MISMATCH ticket=", ticket, " id=", cmd_id);
         bool posted = PostResult(cmd_id, false, "MAGIC_MISMATCH", "", 0, "magic mismatch — not my position");
         if(posted) MarkProcessed(cmd_id);
         return true;
        }

      bool res    = g_trade.PositionClosePartial(ticket, vol);
      ok          = res;
      retcode_str = IntegerToString((long)g_trade.ResultRetcode());
      ulong deal  = g_trade.ResultDeal();
      deal_ticket = (deal > 0) ? IntegerToString((long)deal) : "";
      fill_price  = g_trade.ResultPrice();
      message     = g_trade.ResultRetcodeDescription();
     }
   else if(cmd_type == "close_full")
     {
      string pos_id = JStr(payload, "positionId");
      ulong  ticket = (ulong)StringToInteger(pos_id);

      if(!PositionSelectByTicket(ticket))
        {
         Print("[executor] close_full: position ", ticket, " not found id=", cmd_id);
         bool posted = PostResult(cmd_id, false, "NOT_FOUND", "", 0, "position not found");
         if(posted) MarkProcessed(cmd_id);
         return true;
        }
      if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
        {
         Print("[executor] MAGIC_MISMATCH ticket=", ticket, " id=", cmd_id);
         bool posted = PostResult(cmd_id, false, "MAGIC_MISMATCH", "", 0, "magic mismatch — not my position");
         if(posted) MarkProcessed(cmd_id);
         return true;
        }

      bool res    = g_trade.PositionClose(ticket);
      ok          = res;
      retcode_str = IntegerToString((long)g_trade.ResultRetcode());
      ulong deal  = g_trade.ResultDeal();
      deal_ticket = (deal > 0) ? IntegerToString((long)deal) : "";
      fill_price  = g_trade.ResultPrice();
      message     = g_trade.ResultRetcodeDescription();
     }
   else if(cmd_type == "cancel_order")
     {
      string ord_id = JStr(payload, "orderId");
      ulong  ticket = (ulong)StringToInteger(ord_id);

      // find the order by ticket to verify magic
      bool found = false;
      int  total = OrdersTotal();
      for(int i = 0; i < total; i++)
        {
         if(OrderGetTicket(i) == ticket) { found = true; break; }
        }
      if(!found)
        {
         Print("[executor] cancel_order: order ", ticket, " not found id=", cmd_id);
         bool posted = PostResult(cmd_id, false, "NOT_FOUND", "", 0, "order not found");
         if(posted) MarkProcessed(cmd_id);
         return true;
        }
      if(OrderGetInteger(ORDER_MAGIC) != MagicNumber)
        {
         Print("[executor] MAGIC_MISMATCH order=", ticket, " id=", cmd_id);
         bool posted = PostResult(cmd_id, false, "MAGIC_MISMATCH", "", 0, "magic mismatch — not my order");
         if(posted) MarkProcessed(cmd_id);
         return true;
        }

      bool res    = g_trade.OrderDelete(ticket);
      ok          = res;
      retcode_str = IntegerToString((long)g_trade.ResultRetcode());
      message     = g_trade.ResultRetcodeDescription();
     }
   else
     {
      Print("[executor] UNKNOWN command type=", cmd_type, " id=", cmd_id);
      bool posted = PostResult(cmd_id, false, "UNKNOWN_TYPE", "", 0, "unknown command type: " + cmd_type);
      if(posted) MarkProcessed(cmd_id);
      return true;
     }

   Print("[executor] result: type=", cmd_type, " ok=", ok,
         " retcode=", retcode_str, " deal=", deal_ticket, " id=", cmd_id);
   bool posted = PostResult(cmd_id, ok, retcode_str, deal_ticket, fill_price, message);
   if(posted) MarkProcessed(cmd_id);
   else Print("[executor] WARNING: result POST failed — id=", cmd_id, " NOT marked processed");
   return true;
  }

//+------------------------------------------------------------------+
//| OnInit                                                           |
//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(TerminalToken) == 0)
     {
      Print("[executor] ERROR: TerminalToken is empty — set input before attaching");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(StringFind(BackendURL, "https://") != 0)
     {
      Print("[executor] ERROR: BackendURL must start with https://");
      return INIT_PARAMETERS_INCORRECT;
     }

   Print("[executor] v1.0 starting — DryRun=", DryRun,
         " Magic=", MagicNumber, " MaxLots=", MaxLotsPerCmd);
   Print("[executor] Backend: ", BackendURL);

   g_trade.SetExpertMagicNumber((ulong)MagicNumber);
   g_trade.SetDeviationInPoints(20);

   LoadProcessedIds();

   EventSetMillisecondTimer(PollIntervalMs);

   // Test poll — diagnose whitelist on first run
   int http_code;
   HttpReq("GET", "/ea/poll", "", http_code);
   if(http_code == -1)
     {
      Print("===================================================");
      Print("[executor] WebRequest FAILED — URL NOT WHITELISTED");
      Print("Go to: Tools -> Options -> Expert Advisors");
      Print("Check 'Allow WebRequests for listed URL' and add:");
      Print("  ", BackendURL);
      Print("EA will keep retrying after the URL is added.");
      Print("===================================================");
      g_url_ok = false;
     }
   else
     {
      Print("[executor] Initial poll OK (http ", http_code, ") — EA active");
      g_url_ok = true;
      OnHttpOk();
      PushState();
     }

   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
//| OnDeinit                                                         |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   Print("[executor] stopping (reason=", reason, ") — final state push");
   PushState(); // best-effort
  }

//+------------------------------------------------------------------+
//| OnTimer                                                          |
//+------------------------------------------------------------------+
void OnTimer()
  {
   if(InBackoff()) return;

   // --- poll ---
   int    http_code;
   string response = HttpReq("GET", "/ea/poll", "", http_code);

   if(http_code == -1)
     {
      // Rate-limited log for whitelist / network issues
      if(TimeGMT() - g_last_nourl_warn >= 30)
        {
         g_last_nourl_warn = TimeGMT();
         if(!g_url_ok)
            Print("[executor] WebRequest still failing — whitelist ", BackendURL,
                  " via Tools -> Options -> Expert Advisors");
         else
            Print("[executor] Network error on /ea/poll — will retry");
        }
      OnHttpFail("/ea/poll");
      return;
     }
   if(http_code < 200 || http_code > 299)
     {
      OnHttpFail("/ea/poll http=" + IntegerToString(http_code));
      return;
     }

   OnHttpOk();
   g_url_ok = true;

   // --- parse and execute commands ---
   string cmds[];
   int cmd_count = SplitCommands(response, cmds);
   bool any_executed = false;

   for(int i = 0; i < cmd_count; i++)
     {
      string cmd_id   = JStr(cmds[i], "id");
      string cmd_type = JStr(cmds[i], "type");
      string payload  = JObj(cmds[i], "payload");

      if(StringLen(cmd_id) == 0 || StringLen(cmd_type) == 0)
        {
         Print("[executor] WARNING: malformed command: ", cmds[i]);
         continue;
        }

      if(ExecuteCommand(cmd_id, cmd_type, payload))
         any_executed = true;
     }

   // --- push state on interval or immediately after execution ---
   bool state_due = ((TimeGMT() - g_last_state_push) * 1000 >= StateIntervalMs);
   if(state_due || any_executed)
      PushState();
  }
//+------------------------------------------------------------------+
