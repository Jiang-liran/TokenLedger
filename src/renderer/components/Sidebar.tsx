import { useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  Wallet,
  X,
  XCircle,
} from 'lucide-react';
import type { ConversationSummary } from '../../shared/types';
import { formatRelativeTime, formatUsd } from '../../shared/cost/format';
import { useAppStore } from '../store';
import { Modal } from './ui';

function ConversationRow({
  conversation,
  active,
  onMenu,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onMenu: (conversation: ConversationSummary, x: number, y: number) => void;
}) {
  const selectConversation = useAppStore((state) => state.selectConversation);
  return (
    <div
      className={`conv-item ${active ? 'active' : ''}`}
      data-testid="conversation-item"
      role="button"
      tabIndex={0}
      onClick={() => void selectConversation(conversation.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') void selectConversation(conversation.id);
      }}
    >
      <div className="conv-item-row">
        <span className="conv-title" title={conversation.title}>
          {conversation.title}
        </span>
        {conversation.archivedAt ? <span className="conv-archived">已归档</span> : null}
        <button
          className="conv-menu-btn"
          aria-label="会话操作"
          onClick={(event) => {
            event.stopPropagation();
            onMenu(conversation, event.clientX, event.clientY);
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      </div>
      <div className="conv-meta">
        <span>{formatRelativeTime(conversation.updatedAt)}</span>
        <span>·</span>
        <span>{conversation.tokensKnown ? `${conversation.totalTokens.toLocaleString('en-US')} Tokens` : '用量未知'}</span>
        <span className="conv-cost">
          {conversation.unknownCostRequestCount > 0
            ? conversation.costUsd === '0'
              ? '费用未知'
              : `${formatUsd(conversation.costUsd)} + 未知`
            : conversation.costUsdComplete
              ? formatUsd(conversation.costUsd)
              : `${formatUsd(conversation.costUsd)} + 部分`}
        </span>
      </div>
    </div>
  );
}

export function Sidebar() {
  const conversations = useAppStore((state) => state.conversations);
  const activeId = useAppStore((state) => state.activeId);
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const includeArchived = useAppStore((state) => state.includeArchived);
  const setIncludeArchived = useAppStore((state) => state.setIncludeArchived);
  const newConversation = useAppStore((state) => state.newConversation);
  const page = useAppStore((state) => state.page);
  const selectPage = useAppStore((state) => state.selectPage);
  const renameConversation = useAppStore((state) => state.renameConversation);
  const archiveConversation = useAppStore((state) => state.archiveConversation);
  const deleteConversation = useAppStore((state) => state.deleteConversation);
  const purgeConversation = useAppStore((state) => state.purgeConversation);
  const askConfirm = useAppStore((state) => state.askConfirm);
  const openBalance = useAppStore((state) => state.openBalance);
  const meta = useAppStore((state) => state.meta);

  const [menuFor, setMenuFor] = useState<ConversationSummary | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(q) ||
        conversation.lastMessagePreview.toLowerCase().includes(q),
    );
  }, [conversations, search]);

  const archivedCount = conversations.filter((conversation) => conversation.archivedAt).length;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <span className="brand-mark">T</span>
          <span>TokenLedger</span>
        </div>
      </div>

      <div className="sidebar-actions">
        <button className="new-chat-btn" onClick={() => void newConversation()} data-testid="new-chat-button">
          <Plus size={14} /> 新建对话
        </button>
      </div>

      <div className="sidebar-search">
        <div className="search-box">
          <Search size={13} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
          {search ? (
            <button className="search-clear" onClick={() => setSearch('')} aria-label="清除搜索">
              <X size={11} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="sidebar-label">
        <span>历史会话</span>
        <button
          className="inline-flex items-center gap-1 text-[10.5px] hover:text-[var(--text)]"
          onClick={() => setIncludeArchived(!includeArchived)}
          title="切换是否显示已归档会话"
        >
          {includeArchived ? '隐藏归档' : `归档 ${archivedCount || ''}`}
        </button>
      </div>

      <div className="sidebar-scroll" data-testid="conversation-list">
        {filtered.length === 0 ? (
          <p className="hint" style={{ padding: '14px 10px' }}>
            {conversations.length === 0 ? '还没有会话。点击“新建对话”开始。' : '没有匹配的会话。'}
          </p>
        ) : (
          filtered.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeId && page === 'chat'}
              onMenu={(target, x, y) => {
                setMenuFor(target);
                setMenuPos({ x, y });
              }}
            />
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button className={`nav-item ${page === 'usage' ? 'active' : ''}`} onClick={() => selectPage('usage')}>
          <BarChart3 size={14} />
          用量统计
        </button>
        <button
          className={`nav-item ${page === 'settings' ? 'active' : ''}`}
          onClick={() => selectPage('settings')}
        >
          <Settings size={14} />
          设置
        </button>
        <button className="nav-item" onClick={() => void openBalance()}>
          <Wallet size={14} />
          DeepSeek 余额
        </button>
        <div className="px-2 pb-1 pt-2 text-[10px] text-[var(--text-tertiary)]">
          v{meta?.version ?? '1.0.0'}
          {meta?.testMode ? ' · 测试模式' : ''}
        </div>
      </div>

      {menuFor && menuPos ? (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
            onMouseDown={() => setMenuFor(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuFor(null);
            }}
          />
          <div
            className="popover"
            style={{
              position: 'fixed',
              zIndex: 50,
              width: 210,
              left: Math.max(8, Math.min(menuPos.x, window.innerWidth - 228)),
              top: Math.max(8, Math.min(menuPos.y + 6, window.innerHeight - 220)),
            }}
          >
            <div className="popover-header">
              <span className="truncate" style={{ maxWidth: 170 }}>
                {menuFor.title}
              </span>
            </div>
            <button
              className="menu-item"
              onClick={() => {
                setRenameValue(menuFor.title);
                setRenameTarget(menuFor);
                setMenuFor(null);
              }}
            >
              <Pencil size={13} /> 重命名
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void archiveConversation(menuFor.id, !menuFor.archivedAt);
                setMenuFor(null);
              }}
            >
              {menuFor.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              {menuFor.archivedAt ? '取消归档' : '归档'}
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={async () => {
                const target = menuFor;
                setMenuFor(null);
                const confirmed = await askConfirm({
                  title: '从列表移除会话？',
                  message: '会话将从侧边栏隐藏，但聊天记录与费用统计仍保留在全局统计中。',
                  confirmLabel: '移除',
                  danger: false,
                });
                if (confirmed) await deleteConversation(target.id);
              }}
            >
              <Trash2 size={13} /> 从列表移除
            </button>
            <button
              className="menu-item danger"
              onClick={async () => {
                const target = menuFor;
                setMenuFor(null);
                const confirmed = await askConfirm({
                  title: '彻底删除会话？',
                  message: '将永久删除该会话的聊天记录、请求记录与费用，且无法恢复。',
                  confirmLabel: '彻底删除',
                  danger: true,
                });
                if (confirmed) await purgeConversation(target.id);
              }}
            >
              <XCircle size={13} /> 彻底删除
            </button>
          </div>
        </>
      ) : null}

      <Modal
        open={!!renameTarget}
        title="重命名会话"
        onClose={() => setRenameTarget(null)}
        actions={
          <>
            <button className="btn" onClick={() => setRenameTarget(null)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={!renameValue.trim()}
              onClick={async () => {
                if (!renameTarget) return;
                await renameConversation(renameTarget.id, renameValue.trim());
                setRenameTarget(null);
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
          autoFocus
          maxLength={160}
        />
      </Modal>
    </aside>
  );
}
