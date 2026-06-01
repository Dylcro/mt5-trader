import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Platform } from "react-native";

const TOKEN_KEY = "auth_token";
const API_BASE = process.env.EXPO_PUBLIC_API_URL || "/api";

export interface AuthUser {
  id: number;
  email: string;
}

interface AuthContextValue {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AuthUser | null;
  getToken: () => Promise<string | null>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (fullName: string, email: string, password: string, inviteCode?: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function decodeJwt(token: string): { sub: string; email: string; exp: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]!));
    return payload;
  } catch {
    return null;
  }
}

function isTokenValid(token: string): boolean {
  const payload = decodeJwt(token);
  if (!payload) return false;
  return payload.exp * 1000 > Date.now();
}

async function storeToken(token: string): Promise<void> {
  if (Platform.OS === "web") {
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
  } else {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  }
}

async function loadToken(): Promise<string | null> {
  if (Platform.OS === "web") {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  return AsyncStorage.getItem(TOKEN_KEY);
}

async function clearToken(): Promise<void> {
  if (Platform.OS === "web") {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  } else {
    await AsyncStorage.removeItem(TOKEN_KEY);
  }
}

function tokenToUser(token: string): AuthUser | null {
  const payload = decodeJwt(token);
  if (!payload) return null;
  return { id: Number(payload.sub), email: payload.email };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    loadToken().then((stored) => {
      if (stored && isTokenValid(stored)) {
        setToken(stored);
        setUser(tokenToUser(stored));
      } else if (stored) {
        clearToken();
      }
      setIsLoaded(true);
    });
  }, []);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (token && isTokenValid(token)) return token;
    return null;
  }, [token]);

  const signIn = useCallback(async (email: string, password: string): Promise<{ error?: string }> => {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || "Login failed." };
      await storeToken(data.token);
      setToken(data.token);
      setUser(data.user);
      return {};
    } catch {
      return { error: "Network error. Check your connection." };
    }
  }, []);

  const signUp = useCallback(async (fullName: string, email: string, password: string, inviteCode?: string): Promise<{ error?: string }> => {
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email, password, inviteCode: inviteCode?.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || "Registration failed." };
      await storeToken(data.token);
      setToken(data.token);
      setUser(data.user);
      return {};
    } catch {
      return { error: "Network error. Check your connection." };
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await clearToken();
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ isLoaded, isSignedIn: !!user, user, getToken, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
