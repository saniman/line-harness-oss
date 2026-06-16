'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useAccount } from '@/contexts/account-context'

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-sm text-gray-500">
      {children}
    </div>
  )
}

/** LINE account must be selected before showing booking (and similar) admin content. */
export default function AccountGate({ children }: { children: ReactNode }) {
  const { selectedAccountId, loading, accounts, setSelectedAccountId, error, refreshAccounts } =
    useAccount()

  if (loading) {
    return <Panel>アカウント情報を読み込み中…</Panel>
  }

  if (!selectedAccountId && accounts.length > 0) {
    return (
      <Panel>
        <p className="mb-4">予約管理対象の LINE アカウントを選んでください。</p>
        <div className="flex flex-col gap-2 max-w-sm mx-auto">
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => setSelectedAccountId(account.id)}
              className="px-4 py-3 rounded-lg border border-gray-200 hover:border-green-500 hover:bg-green-50 text-left transition-colors"
            >
              <p className="font-medium text-gray-900">{account.displayName || account.name}</p>
              {account.basicId && (
                <p className="text-xs text-gray-400 mt-0.5">{account.basicId}</p>
              )}
            </button>
          ))}
        </div>
      </Panel>
    )
  }

  if (!selectedAccountId) {
    return (
      <Panel>
        <p className="mb-2 font-medium text-gray-700">LINE アカウントが選択されていません</p>
        {error && <p className="text-red-600 mb-3 text-xs">{error}</p>}
        <p className="mb-4 text-xs text-gray-400">
          単一アカウント構成では、ページを再読み込みすると wrangler の LINE 設定から自動登録されます。
          サイドバー上部（ロゴの下）から選ぶか、設定 → LINEアカウント を確認してください。
        </p>
        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <button
            type="button"
            onClick={() => void refreshAccounts()}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            再読み込み
          </button>
          <Link
            href="/accounts"
            className="px-4 py-2 rounded-lg text-white inline-block"
            style={{ backgroundColor: '#06C755' }}
          >
            LINEアカウント設定へ
          </Link>
        </div>
      </Panel>
    )
  }

  return <>{children}</>
}
