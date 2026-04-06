import ChatPanel from "@/components/ChatPanel";
import AgentStatusCard from "@/components/AgentStatusCard";
import JupiterPanel from "@/components/JupiterPanel";
import AppControlPanel from "@/components/AppControlPanel";
import PreflightStatusCard from "@/components/PreflightStatusCard";
import SherpaPanel from "@/components/SherpaPanel";
import TopBarUpdateButton from "@/components/TopBarUpdateButton";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-black text-white p-6">
      <div className="mx-auto mb-6 max-w-7xl rounded-3xl border border-cyan-400/20 bg-cyan-500/5 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-wide">MORK CONTROL PANEL</h1>
            <p className="mt-1 text-sm text-white/70">
              Unified surface for app operations, vibecode sessions, channel personas, and trade execution.
            </p>
          </div>
          <TopBarUpdateButton />
        </div>
      </div>

      <div className="mx-auto max-w-7xl grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2 space-y-6">
          <ChatPanel />
          <JupiterPanel />
          <SherpaPanel />
        </section>

        <section className="space-y-6">
          <AppControlPanel />
          <AgentStatusCard />
          <PreflightStatusCard />
        </section>
      </div>
    </main>
  );
}
