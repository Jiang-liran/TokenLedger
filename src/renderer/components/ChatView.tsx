import { AlertTriangle, X } from 'lucide-react';
import { useAppStore } from '../store';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { LoadingDots } from './ui';

export function ChatView() {
  const error = useAppStore((state) => state.error);
  const clearError = useAppStore((state) => state.clearError);
  const loading = useAppStore((state) => state.loadingConversation);

  return (
    <div className="chat-layout">
      <ChatHeader />
      {error ? (
        <div style={{ padding: '10px 20px 0' }}>
          <div className="error-banner" style={{ marginBottom: 0 }} data-testid="error-banner">
            <AlertTriangle size={14} className="mt-0.5 flex-none" />
            <span className="flex-1" style={{ whiteSpace: 'pre-wrap' }}>
              {error}
            </span>
            <button className="icon-btn h-5 w-5" onClick={clearError} aria-label="关闭错误提示">
              <X size={12} />
            </button>
          </div>
        </div>
      ) : null}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <LoadingDots />
        </div>
      ) : (
        <MessageList />
      )}
      <Composer />
    </div>
  );
}
