import { useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Download,
  FileJson,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useAppStore, emptyConversationStats } from '../store';
import { ConversationCost, ConversationStatsPanel } from './CostDetails';
import { ModelPicker } from './ModelPicker';
import { Modal, Popover } from './ui';

const PROVIDER_LABEL = { openai: 'OpenAI', deepseek: 'DeepSeek' } as const;

export function ChatHeader() {
  const detail = useAppStore((state) => state.detail);
  const activeId = useAppStore((state) => state.activeId);
  const provider = useAppStore((state) => state.provider);
  const model = useAppStore((state) => state.model);
  const modelsByProvider = useAppStore((state) => state.modelsByProvider);
  const renameConversation = useAppStore((state) => state.renameConversation);
  const archiveConversation = useAppStore((state) => state.archiveConversation);
  const deleteConversation = useAppStore((state) => state.deleteConversation);
  const purgeConversation = useAppStore((state) => state.purgeConversation);
  const exportMarkdown = useAppStore((state) => state.exportConversationMarkdown);
  const exportJson = useAppStore((state) => state.exportConversationJson);
  const askConfirm = useAppStore((state) => state.askConfirm);
  const titleJobs = useAppStore((state) => state.titleJobs);
  const regenerateTitle = useAppStore((state) => state.regenerateTitle);

  const [modelOpen, setModelOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const stats = detail?.stats ?? emptyConversationStats(activeId ?? 'none');
  const conversation = detail?.conversation ?? null;
  const modelName = useMemo(() => {
    const found = modelsByProvider[provider]?.models.find((item) => item.id === model);
    return found?.displayName ?? model;
  }, [modelsByProvider, provider, model]);

  const displayTitle = conversation?.title ?? (activeId ? '对话' : '新对话');
  const titleBusy = activeId ? !!titleJobs[activeId] : false;

  return (
    <header className="chat-header">
      <div className="chat-header-title">
        <h1 title={displayTitle}>
          {displayTitle}
          {titleBusy ? <span className="ml-2 text-[10.5px] font-normal text-[var(--text-tertiary)]">AI 命名中…</span> : null}
        </h1>
        <div className="chat-header-sub">
          <span
            className="status-dot"
            style={{ background: provider === 'openai' ? '#10a37f' : '#4d6bfe' }}
          />
          <span>
            {PROVIDER_LABEL[provider]} · {modelName}
          </span>
          {conversation ? (
            <>
              <span>·</span>
              <span>{stats.turnCount} 轮</span>
              <span>·</span>
              <span>{stats.requestCount} 次请求</span>
            </>
          ) : (
            <span>· 发送第一条消息后开始统计</span>
          )}
        </div>
      </div>

      <div className="relative flex-none">
        <button className="chip" onClick={() => setModelOpen((value) => !value)} aria-expanded={modelOpen}>
          <span className="truncate" style={{ maxWidth: 160 }}>
            {modelName}
          </span>
          <ChevronDown size={11} style={{ transform: modelOpen ? 'rotate(180deg)' : undefined }} />
        </button>
        <ModelPicker open={modelOpen} onClose={() => setModelOpen(false)} />
      </div>

      <div className="relative flex-none">
        <ConversationCost stats={stats} open={statsOpen} onToggle={() => setStatsOpen((value) => !value)} />
        <Popover open={statsOpen} onClose={() => setStatsOpen(false)} align="right" width={380}>
          <div className="popover-header">
            <span>会话累计</span>
            <span className="hint">按实际 API 请求累计</span>
          </div>
          <div style={{ padding: '0 8px 8px' }}>
            <ConversationStatsPanel stats={stats} />
          </div>
        </Popover>
      </div>

      <div className="relative flex-none">
        <button
          className="icon-btn"
          aria-label="更多会话操作"
          onClick={() => setMenuOpen((value) => !value)}
        >
          <MoreHorizontal size={16} />
        </button>
        <Popover open={menuOpen} onClose={() => setMenuOpen(false)} align="right" width={240}>
          <button
            className="menu-item"
            disabled={!conversation || titleBusy}
            onClick={() => {
              if (!conversation) return;
              setMenuOpen(false);
              void regenerateTitle(conversation.id);
            }}
          >
            <Sparkles size={13} /> {titleBusy ? 'AI 正在生成标题…' : 'AI 重新生成标题'}
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            disabled={!conversation}
            onClick={() => {
              if (!conversation) return;
              setRenameValue(conversation.title);
              setRenameOpen(true);
              setMenuOpen(false);
            }}
          >
            <Pencil size={13} /> 重命名
          </button>
          <button
            className="menu-item"
            disabled={!conversation}
            onClick={() => {
              if (!conversation) return;
              void archiveConversation(conversation.id, !conversation.archivedAt);
              setMenuOpen(false);
            }}
          >
            {conversation?.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            {conversation?.archivedAt ? '取消归档' : '归档会话'}
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            disabled={!conversation}
            onClick={() => {
              void exportMarkdown();
              setMenuOpen(false);
            }}
          >
            <Download size={13} /> 导出 Markdown
          </button>
          <button
            className="menu-item"
            disabled={!conversation}
            onClick={() => {
              void exportJson();
              setMenuOpen(false);
            }}
          >
            <FileJson size={13} /> 导出 JSON
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            disabled={!conversation}
            onClick={async () => {
              if (!conversation) return;
              setMenuOpen(false);
              const confirmed = await askConfirm({
                title: '从列表移除会话？',
                message: '该会话将从侧边栏隐藏，但聊天记录与已产生的费用统计仍会保留在全局统计中。',
                confirmLabel: '移除',
                danger: false,
              });
              if (confirmed) await deleteConversation(conversation.id);
            }}
          >
            <Trash2 size={13} /> 从列表移除（保留统计）
          </button>
          <button
            className="menu-item danger"
            disabled={!conversation}
            onClick={async () => {
              if (!conversation) return;
              setMenuOpen(false);
              const confirmed = await askConfirm({
                title: '彻底删除会话？',
                message:
                  '将永久删除该会话的聊天记录、API 请求记录与费用统计，且无法恢复。全局累计费用会相应减少。',
                detail: '如需保留费用统计，请改用“从列表移除”。',
                confirmLabel: '彻底删除',
                danger: true,
              });
              if (confirmed) await purgeConversation(conversation.id);
            }}
          >
            <XCircle size={13} /> 彻底删除（含统计）
          </button>
        </Popover>
      </div>

      <Modal
        open={renameOpen}
        title="重命名会话"
        onClose={() => setRenameOpen(false)}
        actions={
          <>
            <button className="btn" onClick={() => setRenameOpen(false)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={!renameValue.trim()}
              onClick={async () => {
                if (!conversation) return;
                await renameConversation(conversation.id, renameValue.trim());
                setRenameOpen(false);
              }}
            >
              保存
            </button>
          </>
        }
      >
        <input
          className="input"
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          maxLength={160}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter' && renameValue.trim() && conversation) {
              void renameConversation(conversation.id, renameValue.trim()).then(() =>
                setRenameOpen(false),
              );
            }
          }}
        />
      </Modal>
    </header>
  );
}
