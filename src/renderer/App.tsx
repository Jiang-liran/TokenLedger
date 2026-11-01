import { useEffect } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { useAppStore } from './store';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { UsagePage } from './components/UsagePage';
import { SettingsPage } from './components/SettingsPage';
import { BalanceModal } from './components/BalanceModal';
import { ConfirmDialog, Toasts } from './components/ui';

let bootStarted = false;

export default function App() {
  const ready = useAppStore((state) => state.ready);
  const bootError = useAppStore((state) => state.bootError);
  const page = useAppStore((state) => state.page);
  const bootstrap = useAppStore((state) => state.bootstrap);

  useEffect(() => {
    if (bootStarted) return;
    bootStarted = true;
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const offChat = window.tokenledger.onChatEvent((event) =>
      useAppStore.getState().handleChatEvent(event),
    );
    const offTitle = window.tokenledger.onTitleEvent((event) =>
      useAppStore.getState().handleTitleEvent(event),
    );
    return () => {
      offChat();
      offTitle();
    };
  }, []);

  if (!ready) {
    return (
      <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="empty-card">
          <div className="empty-icon">
            <Sparkles size={24} />
          </div>
          <h1 className="empty-title" style={{ fontSize: 18 }}>
            TokenLedger
          </h1>
          <p className="hint">正在加载本地账本…</p>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="empty-card">
          <div className="empty-icon" style={{ background: 'var(--danger)' }}>
            <AlertTriangle size={24} />
          </div>
          <h1 className="empty-title" style={{ fontSize: 18 }}>
            无法启动本地数据服务
          </h1>
          <p className="empty-sub">{bootError}</p>
          <button className="btn btn-primary mt-2" onClick={() => window.location.reload()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-panel">
        {page === 'chat' ? <ChatView /> : null}
        {page === 'usage' ? <UsagePage /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
      </main>
      <Toasts />
      <ConfirmDialog />
      <BalanceModal />
    </div>
  );
}
