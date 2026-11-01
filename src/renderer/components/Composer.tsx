import { useEffect, useRef, useState } from 'react';
import { ArrowUp, KeyRound, Square } from 'lucide-react';
import { useAppStore } from '../store';

export function Composer() {
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const stopGeneration = useAppStore((state) => state.stopGeneration);
  const generating = useAppStore((state) => state.generating);
  const provider = useAppStore((state) => state.provider);
  const model = useAppStore((state) => state.model);
  const keyStatus = useAppStore((state) => state.keyStatus);
  const selectPage = useAppStore((state) => state.selectPage);
  const activeId = useAppStore((state) => state.activeId);

  const keyConfigured = keyStatus?.[provider]?.configured ?? false;
  const busy = !!generating;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const next = Math.min(200, Math.max(40, element.scrollHeight));
    element.style.height = `${next}px`;
  }, [text]);

  const send = async () => {
    if (!text.trim() || busy) return;
    const value = text;
    const ok = await sendMessage(value);
    if (ok) {
      setText('');
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  return (
    <div className="composer-wrap">
      {!keyConfigured ? (
        <div
          className="warn-banner"
          style={{ maxWidth: 820, margin: '0 auto 8px' }}
          data-testid="missing-key-banner"
        >
          <KeyRound size={14} className="mt-0.5 flex-none" />
          <span className="flex-1">
            尚未配置 {provider === 'openai' ? 'OpenAI' : 'DeepSeek'} API Key，无法发送消息。
          </span>
          <button className="btn btn-sm" onClick={() => selectPage('settings')}>
            前往设置
          </button>
        </div>
      ) : null}

      <div className="composer">
        <textarea
          ref={textareaRef}
          value={text}
          placeholder={activeId ? '输入消息…' : '输入消息开始新对话…'}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !composing &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
          disabled={busy}
          data-testid="composer-input"
          aria-label="消息输入框"
        />
        <div className="composer-bar">
          <span className="composer-hint">
            Enter 发送 · Shift + Enter 换行 · {provider}/{model}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {busy ? (
              <button className="stop-btn" onClick={() => void stopGeneration()} data-testid="stop-button">
                <Square size={10} fill="currentColor" /> 停止生成
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={() => void send()}
                disabled={!text.trim()}
                aria-label="发送消息"
                data-testid="send-button"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
