import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";

const C = Colors.dark;

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Para({ children }: { children: React.ReactNode }) {
  return <Text style={styles.para}>{children}</Text>;
}

export default function PrivacyScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={C.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Privacy Policy</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.lastUpdated}>Last updated: May 2025</Text>

        <Para>
          XAUUSD Trader ("the App", "we", "our") is a mobile and web application that
          connects to your MetaTrader 5 account via MetaAPI to display positions and
          execute cascade ladder trades on XAUUSD (Gold). This Privacy Policy explains
          what information we collect, how we use it, and how we protect it.
        </Para>

        <Section title="1. Information We Collect">
          <Para>
            <Text style={styles.bold}>Account credentials.</Text> When you sign up we
            collect your email address and a hashed password managed by Clerk, our
            authentication provider. We never store your password in plain text.
          </Para>
          <Para>
            <Text style={styles.bold}>MetaTrader 5 credentials.</Text> Your MT5 account
            number, server name, and trading password are stored encrypted in our database
            solely to connect to MetaAPI on your behalf. We do not sell, share, or log
            these credentials beyond what is required for the trading connection.
          </Para>
          <Para>
            <Text style={styles.bold}>Trading activity.</Text> Trade history, open
            positions, and balance data are retrieved from your MT5 broker via MetaAPI.
            This data is displayed in the App and may be stored temporarily for
            performance and deduplication purposes.
          </Para>
          <Para>
            <Text style={styles.bold}>Usage data.</Text> We collect standard server logs
            (IP address, request timestamps, error traces) to operate and debug the
            service. No third-party analytics SDKs are embedded in the App.
          </Para>
        </Section>

        <Section title="2. How We Use Your Information">
          <Para>• To authenticate you and maintain your session.</Para>
          <Para>• To connect to your MT5 account and execute trades you authorise.</Para>
          <Para>• To detect and prevent duplicate or erroneous orders.</Para>
          <Para>• To respond to support requests you submit through the App.</Para>
          <Para>• To maintain the security and integrity of the service.</Para>
        </Section>

        <Section title="3. Data Sharing">
          <Para>
            We do not sell your personal information. We share data only with:
          </Para>
          <Para>
            <Text style={styles.bold}>Clerk</Text> (authentication) — manages your email
            and session tokens. Subject to Clerk's privacy policy at clerk.com/privacy.
          </Para>
          <Para>
            <Text style={styles.bold}>MetaAPI</Text> — acts as an intermediary to your
            MT5 broker. Your MT5 credentials are transmitted to MetaAPI over TLS to
            establish the trading connection. Subject to MetaAPI's terms at metaapi.cloud.
          </Para>
          <Para>
            <Text style={styles.bold}>Your MT5 broker</Text> — all trades are executed
            directly on your broker's server. We have no control over your broker's
            privacy practices.
          </Para>
        </Section>

        <Section title="4. Data Retention">
          <Para>
            Your account data is retained for as long as your account exists. You may
            request account deletion by contacting us via the Help & Support screen.
            Upon deletion, your MT5 credentials and personal data are permanently removed
            within 30 days.
          </Para>
        </Section>

        <Section title="5. Security">
          <Para>
            MT5 credentials are encrypted at rest using industry-standard encryption.
            All data in transit is protected by TLS 1.2 or higher. We use role-based
            access controls to limit who within our systems can access your data.
          </Para>
        </Section>

        <Section title="6. Your Rights">
          <Para>
            Depending on your jurisdiction you may have the right to access, correct,
            export, or delete the personal data we hold about you. To exercise these
            rights, please contact us through the Help & Support screen in the App.
          </Para>
        </Section>

        <Section title="7. Children">
          <Para>
            The App is intended for adults aged 18 and over. We do not knowingly collect
            information from anyone under 18. Financial trading involves substantial risk
            and is not appropriate for minors.
          </Para>
        </Section>

        <Section title="8. Changes to This Policy">
          <Para>
            We may update this Privacy Policy from time to time. Continued use of the App
            after changes are posted constitutes your acceptance of the revised policy. We
            will indicate the date of the latest revision at the top of this page.
          </Para>
        </Section>

        <Section title="9. Contact">
          <Para>
            For privacy-related enquiries please use the Help & Support screen inside the
            App. We aim to respond within 5 business days.
          </Para>
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  scroll: {
    padding: 24,
    gap: 16,
  },
  lastUpdated: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginBottom: 4,
  },
  section: {
    gap: 8,
    marginTop: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: C.gold,
    marginBottom: 2,
  },
  para: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 22,
  },
  bold: {
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
});
