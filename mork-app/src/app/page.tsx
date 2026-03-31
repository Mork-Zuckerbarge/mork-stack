import ChatPanel from "@/components/ChatPanel";
import WalletPanel from "@/components/WalletPanel";
import AgentStatusCard from "@/components/AgentStatusCard";
import JupiterPanel from "@/components/JupiterPanel";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-black text-white p-6">
      <div className="mx-auto max-w-7xl grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2">
          <ChatPanel />
        </section>

        <section className="space-y-6">
          <AgentStatusCard />
          <WalletPanel />
          <JupiterPanel />
        </section>
      </div>
    </main>
  );
}
