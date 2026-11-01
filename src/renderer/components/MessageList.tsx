import { useEffect, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Copy,
  KeyRound,
  RotateCcw,
  Settings2,
  Sparkles,
} from 'lucide-react';
import type { StoredMessage, TurnView } from '../../shared/types';
import { formatDateTime } from '../../shared/cost/format';
import { useAppStore } from '../store';
import { Markdown } from './Markdown';
import { TurnCost } from './CostDetails';

const PROVIDER_LABEL = { openai: 'OpenAI', deepseek: 'DeepSeek' } as const;

function latestAssistant(turn: TurnView): StoredMessage | null {
  const attempts = [...turn.assistantMessages].sort((a, b) => a.attempt - b.attempt);
  return attempts[attempts.length - 1] ?? null;
}

function AssistantTurn({ turn }: { turn: TurnView }) {
  const streamText = useAppStore((state) => state.streamText);
  const showReasoning = useAppStore((state) => state.settings?.showReasoning ?? true);
  const regenerate = useAppStore((state) => state.regenerate);
  const pushToast = useAppStore((state) => state.pushToast);
  const provider = useAppStore((state) => state.provider);
  const model = useAppStore((state) => state.model);

  const message = latestAssistant(turn);
  if (!message) {
    return (
      <div className="msg-row msg-assistant">
        <div className="assistant-head">
          <span className="assistant-avatar">
            <Bot size={12} />
          </span>
          <span>助手</span>
        </div>
        <div className="assistant-body">
          <p className="hint">该轮没有助手回复。</p>
        </div>
      </div>
    );
  }

  const stream = streamText[message.id];
  const isStreaming = message.status === 'streaming';
  const content = stream ? stream.text : message.content;
  const reasoning = stream ? stream.reasoning : message.reasoningContent ?? '';
  const attempts = turn.assistantMessages.length;

  return (
    <div className="msg-row msg-assistant" data-testid="assistant-message">
      <div className="assistant-head">
        <span className="assistant-avatar">
          <Bot size={12} />
        </span>
        <span>{message.provider ? PROVIDER_LABEL[message.provider] : '助手'}</span>
        <span>·</span>
        <span className="mono">{message.model ?? ''}</span>
        <span>·</span>
        <span>{formatDateTime(message.createdAt)}</span>
        {attempts > 1 ? <span className="badge">已重生成 {attempts - 1} 次</span> : null}
        {isStreaming ? <span className="hint">生成中…</span> : null}
      </div>

      <div className="assistant-body">
        {reasoning && showReasoning ? (
          <details className="reasoning" open={isStreaming ? true : undefined}>
            <summary>
              <Sparkles size={11} /> 思考过程{isStreaming ? '（实时）' : ''}
            </summary>
            <div className="reasoning-body">{reasoning}</div>
          </details>
        ) : null}

        {message.status === 'error' ? (
          <div className="error-banner">
            <AlertTriangle size={14} className="mt-0.5 flex-none" />
            <div className="flex-1">
              <div>{message.errorDetails ?? '本次回复未能完成。'}</div>
              <button
                className="btn btn-sm mt-2"
                onClick={() => void regenerate(turn.turn.id, message.id)}
                disabled={isStreaming}
              >
                <RotateCcw size={11} /> 重试这一轮
              </button>
            </div>
          </div>
        ) : null}

        {content ? (
          <Markdown content={content} />
        ) : isStreaming ? (
          <div className="hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="stream-cursor" style={{ animation: 'blink 1s steps(2, start) infinite' }} />
            正在等待模型输出…
          </div>
        ) : (
          <p className="hint">（空回复）</p>
        )}

        {isStreaming && content ? <span className="stream-cursor" /> : null}

        {!isStreaming && message.errorDetails && message.status === 'complete' ? (
          <div className="warn-banner">
            <AlertTriangle size={13} className="mt-0.5 flex-none" />
            <span style={{ whiteSpace: 'pre-wrap' }}>{message.errorDetails}</span>
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!isStreaming ? <TurnCost turn={turn} /> : null}
        </div>

        {!isStreaming ? (
          <div className="msg-actions" style={{ paddingLeft: 0, marginTop: 6 }}>
            <button
              className="msg-action"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(content);
                  pushToast('success', '已复制回复');
                } catch {
                  pushToast('error', '复制失败');
                }
              }}
            >
              <Copy size={11} /> 复制
            </button>
            <button
              className="msg-action"
              onClick={() => void regenerate(turn.turn.id, message.id)}
              title="重新生成会产生新的真实 API 请求，费用会累加到本轮"
            >
              <RotateCcw size={11} /> 重新生成
            </button>
            <span className="hint" style={{ marginLeft: 4 }}>
              使用 {PROVIDER_LABEL[provider]} · {model}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Welcome() {
  const keyStatus = useAppStore((state) => state.keyStatus);
  const provider = useAppStore((state) => state.provider);
  const meta = useAppStore((state) => state.meta);
  const selectPage = useAppStore((state) => state.selectPage);
  const sendMessage = useAppStore((state) => state.sendMessage);
  const keyConfigured = keyStatus?.[provider]?.configured ?? false;

  const suggestions = [
    '用通俗的语言解释一下什么是死锁，并给出一个生活化的例子。',
    '帮我审查一段 TypeScript 代码，指出潜在的类型安全问题。',
    '比较 OpenAI 和 DeepSeek 的缓存计费差异，用表格总结。',
  ];

  return (
    <div className="empty-state">
      <div className="empty-card">
        <div className="empty-icon">
          <Sparkles size={26} />
        </div>
        <h2 className="empty-title">TokenLedger</h2>
        <p className="empty-sub">
          本地优先的 AI 对话与费用账本。每一次真实 API 请求都会被记录，并精确归集到本轮、本会话与全局统计。
        </p>

        {!keyConfigured ? (
          <div className="mt-2 flex flex-col items-center gap-2">
            <button className="btn btn-primary" onClick={() => selectPage('settings')}>
              <KeyRound size={13} /> 配置 {PROVIDER_LABEL[provider]} API Key
            </button>
            <span className="hint">密钥保存在 macOS 钥匙串保护的本地加密存储中，不会发送给任何第三方。</span>
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <span className="status-dot ok" /> 已准备好，输入消息即可开始
          </div>
        )}

        <div className="empty-tips">
          {suggestions.map((item, index) => (
            <button
              key={item}
              className="empty-tip text-left"
              onClick={() => {
                if (!keyConfigured) {
                  selectPage('settings');
                  return;
                }
                void sendMessage(item);
              }}
            >
              <b>
                {index === 0 ? '解释概念' : index === 1 ? '代码审查' : '对比分析'}
                <ArrowUpRight size={11} className="ml-1 inline" />
              </b>
              {item}
            </button>
          ))}
        </div>

        {meta?.testMode ? (
          <div className="badge mt-2">测试模式：使用模拟流式响应，不访问真实 API</div>
        ) : null}

        <div className="mt-3 flex items-center gap-4 text-[11px] text-[var(--text-tertiary)]">
          <span className="inline-flex items-center gap-1">
            <Settings2 size={11} /> 数据保存在本机
          </span>
          <span className="inline-flex items-center gap-1">
            <AlertTriangle size={11} /> 费用为估算值
          </span>
        </div>
      </div>
    </div>
  );
}

export function MessageList() {
  const detail = useAppStore((state) => state.detail);
  const generating = useAppStore((state) => state.generating);
  const streamText = useAppStore((state) => state.streamText);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const conversationId = detail?.conversation.id ?? null;
  const turns = detail?.turns ?? [];

  const lastTurnId = turns.length > 0 ? turns[turns.length - 1]?.turn.id : null;
  const lastTurnRequests = useMemo(() => {
    const last = turns[turns.length - 1];
    return last?.stats.requestCount ?? 0;
  }, [turns]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = true;
    element.scrollTop = element.scrollHeight;
  }, [conversationId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [turns, streamText, generating, lastTurnId, lastTurnRequests]);

  if (!detail || detail.turns.length === 0) {
    return (
      <div className="chat-scroll" ref={scrollRef}>
        <Welcome />
      </div>
    );
  }

  return (
    <div
      className="chat-scroll"
      ref={scrollRef}
      data-testid="message-scroll"
      onScroll={(event) => {
        const element = event.currentTarget;
        stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
      }}
    >
      <div className="chat-inner">
        {detail.turns.map((turn) => {
          const user = turn.userMessage;
          return (
            <div key={turn.turn.id} data-testid="turn">
              {user ? (
                <div className="msg-row msg-user">
                  <div className="bubble-user" data-testid="user-message">
                    {user.content}
                  </div>
                  <div className="flex items-center gap-2 text-[10.5px] text-[var(--text-tertiary)]">
                    <span>{formatDateTime(user.createdAt)}</span>
                    <button
                      className="msg-action"
                      style={{ height: 18, opacity: 1 }}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(user.content);
                        } catch {
                          // 忽略复制失败
                        }
                      }}
                    >
                      <Copy size={10} /> 复制
                    </button>
                  </div>
                </div>
              ) : null}
              <AssistantTurn turn={turn} />
            </div>
          );
        })}
        {detail.stats.unknownCostRequestCount > 0 ? (
          <div className="warn-banner">
            <AlertTriangle size={13} className="mt-0.5 flex-none" />
            <span>
              本会话有 {detail.stats.unknownCostRequestCount} 次请求费用未知；累计金额只包含可计算的部分，未知费用未被当作 $0。
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
