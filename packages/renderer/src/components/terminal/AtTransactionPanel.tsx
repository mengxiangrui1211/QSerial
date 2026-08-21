/**
 * AT 事务面板 — 把 AT 命令的请求-响应对单独成表，与终端噪声流分开
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface AtTransaction {
  id: string;
  command: string;
  response: string;
  status: 'ok' | 'error' | 'pending';
  timestamp: number;
  durationMs: number;
}

interface AtTransactionPanelProps {
  transactions: AtTransaction[];
  onClear: () => void;
}

export const AtTransactionPanel: React.FC<AtTransactionPanelProps> = ({ transactions, onClear }) => {
  const { t } = useTranslation();

  return (
    <div className="w-[260px] flex flex-col bg-surface border-l border-border flex-shrink-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-medium text-text-tertiary uppercase tracking-wide">
          {t('atPanel.title', 'AT 事务记录')}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-tertiary/60">
            {transactions.length} {t('atPanel.count', '条')}
          </span>
          {transactions.length > 0 && (
            <button
              onClick={onClear}
              className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              title={t('atPanel.clear', '清空')}
            >
              {t('atPanel.clear', '清空')}
            </button>
          )}
        </div>
      </div>

      {/* Transaction List */}
      <div className="flex-1 overflow-y-auto">
        {transactions.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-[11px] text-text-tertiary/40 italic">
              {t('atPanel.empty', '暂无 AT 事务')}
            </span>
          </div>
        ) : (
          transactions.map((tx) => (
            <div
              key={tx.id}
              className="px-3 py-2 border-b border-border/50 hover:bg-hover transition-colors cursor-pointer"
            >
              {/* Command + Status */}
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-xs text-primary">{tx.command}</span>
                {tx.status === 'ok' && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-success/15 text-success">
                    OK
                  </span>
                )}
                {tx.status === 'error' && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-error/15 text-error">
                    ERROR
                  </span>
                )}
                {tx.status === 'pending' && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-warning/15 text-warning animate-pulse">
                    ...
                  </span>
                )}
              </div>

              {/* Response */}
              {tx.response && (
                <div className="font-mono text-[11px] text-text-tertiary leading-relaxed break-all">
                  {tx.response}
                </div>
              )}

              {/* Time + Duration */}
              <div className="text-[10px] text-text-tertiary/50 mt-1">
                {new Date(tx.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
                {' · '}
                {tx.durationMs}ms
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
