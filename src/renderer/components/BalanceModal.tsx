import { ExternalLink, RefreshCw, Wallet } from 'lucide-react';
import { formatDateTime } from '../../shared/cost/format';
import { useAppStore } from '../store';
import { Modal } from './ui';

function currencySymbol(currency: string): string {
  return currency === 'USD' ? '$' : '¥';
}

export function BalanceModal() {
  const open = useAppStore((state) => state.balanceOpen);
  const balance = useAppStore((state) => state.balance);
  const loading = useAppStore((state) => state.balanceLoading);
  const close = useAppStore((state) => state.closeBalance);
  const refresh = useAppStore((state) => state.refreshBalance);
  const openExternal = useAppStore((state) => state.openExternal);

  return (
    <Modal
      open={open}
      title="账户余额"
      subtitle="DeepSeek 余额通过官方接口查询；OpenAI 普通 API Key 不提供余额查询接口。"
      onClose={close}
      width={560}
      actions={
        <>
          <button className="btn" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
          <button className="btn btn-primary" onClick={close}>
            完成
          </button>
        </>
      }
    >
      <div className="card card-pad" style={{ boxShadow: 'none' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wallet size={14} style={{ color: '#4d6bfe' }} />
            <span className="text-[13px] font-semibold">DeepSeek</span>
          </div>
          {balance?.fetchedAt ? (
            <span className="hint">查询于 {formatDateTime(balance.fetchedAt)}</span>
          ) : null}
        </div>

        {loading ? (
          <p className="hint mt-3">正在查询官方余额…</p>
        ) : balance?.ok ? (
          <div className="mt-3">
            <div className="mb-2 flex items-center gap-2 text-[12px]">
              <span className={`status-dot ${balance.isAvailable ? 'ok' : 'warn'}`} />
              {balance.isAvailable ? '当前账户可调用 API' : '当前账户余额不足，无法调用 API'}
            </div>
            {(balance.infos ?? []).length === 0 ? (
              <p className="hint">官方接口未返回余额明细。</p>
            ) : (
              (balance.infos ?? []).map((info) => (
                <div
                  key={info.currency}
                  className="mb-2 rounded-lg border border-[var(--border)] p-3"
                >
                  <div className="text-[17px] font-semibold tabular-nums">
                    {currencySymbol(info.currency)}
                    {info.totalBalance}
                    <span className="ml-2 text-[11px] font-normal text-[var(--text-tertiary)]">
                      {info.currency}
                    </span>
                  </div>
                  <div className="hint mt-1">
                    赠送余额 {currencySymbol(info.currency)}
                    {info.grantedBalance} · 充值余额 {currencySymbol(info.currency)}
                    {info.toppedUpBalance}
                  </div>
                </div>
              ))
            )}
            <p className="hint" style={{ marginTop: 6 }}>
              余额按官方返回的原始币种展示，不做美元换算，也不代表本应用的费用统计。
            </p>
          </div>
        ) : balance ? (
          <div className="warn-banner mt-3">
            <span>{balance.error ?? '查询余额失败。'}</span>
          </div>
        ) : null}
      </div>

      <div className="card card-pad mt-3" style={{ boxShadow: 'none' }}>
        <div className="text-[13px] font-semibold">OpenAI</div>
        <p className="hint mt-2">
          当前不支持通过普通 API Key 直接查询实时余额。请前往官方 Billing 页面查看额度与账单；本应用不会读取浏览器
          Cookie 或登录状态，也不需要高权限 Admin Key。
        </p>
        <button
          className="btn btn-sm mt-2"
          onClick={() =>
            void openExternal('https://platform.openai.com/settings/organization/billing/overview')
          }
        >
          <ExternalLink size={11} /> 打开 OpenAI Billing
        </button>
      </div>
    </Modal>
  );
}
