import { AuthProvider } from "@/components/layout/auth";
import { AppShell } from "@/components/layout/app-shell";
import { VoiceProvider } from "@/components/voice/voice-provider";
import { ConfirmProvider } from "@/components/voice/confirm-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <VoiceProvider>
        <ConfirmProvider>
          <AppShell>{children}</AppShell>
        </ConfirmProvider>
      </VoiceProvider>
    </AuthProvider>
  );
}
