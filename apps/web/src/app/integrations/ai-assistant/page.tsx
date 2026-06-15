'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import type { AiAssistantConfig } from '@/lib/api'
import Header from '@/components/layout/header'

export default function AiAssistantPage() {
  const [config, setConfig] = useState<AiAssistantConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [knowledge, setKnowledge] = useState('')
  const [dailyLimit, setDailyLimit] = useState(10)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.aiAssistant.getConfig().then((res) => {
      if (res.success && res.data) {
        const cfg = res.data
        setConfig(cfg)
        setEnabled(!!cfg.enabled)
        setKnowledge(cfg.knowledge)
        setDailyLimit(cfg.daily_limit)
      }
    })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await api.aiAssistant.updateConfig({
        enabled: enabled ? 1 : 0,
        knowledge,
        daily_limit: dailyLimit,
      })
      if (res.success && res.data) {
        setConfig(res.data)
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      } else {
        setError('保存に失敗しました')
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="AIアシスタント設定"
        description="キーワード・自動返信に当たらないメッセージに、Claude (Haiku) が自動返信します"
      />
      <main className="max-w-2xl mx-auto px-4 py-8">
        <p className="text-sm text-gray-500 mb-8">
          動作確認は「AIテスト 質問文」とLINEに送ると、設定に関わらず自分だけに返信されます。
        </p>

        {!config ? (
          <p className="text-gray-400 text-sm">読み込み中...</p>
        ) : (
          <div className="space-y-6">
            {/* 有効/無効トグル */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-800">AIアシスタントを有効にする</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    有効にすると、未マッチのメッセージに自動返信します
                  </p>
                </div>
                <button
                  onClick={() => setEnabled(!enabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    enabled ? 'bg-green-500' : 'bg-gray-300'
                  }`}
                  aria-label="AIアシスタント有効/無効"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* ナレッジ（店舗情報） */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <label className="block font-semibold text-gray-800 mb-1">
                店舗情報・FAQ（ナレッジ）
              </label>
              <p className="text-xs text-gray-500 mb-3">
                AIが参考にする情報を自由に書いてください（営業時間・住所・料金・よくある質問など）。
                ここに書いていないことは「担当者に確認します」と案内します。
              </p>
              <textarea
                value={knowledge}
                onChange={(e) => setKnowledge(e.target.value)}
                rows={10}
                placeholder={`例：\n店名: WALOVERカフェ\n営業時間: 10:00〜18:00（水曜定休）\n住所: 沖縄県うるま市○○\nドリンク: コーヒー500円〜、スムージー600円〜\n予約: LINE公式アカウントからのみ受付`}
                className="w-full text-sm border border-gray-300 rounded-lg p-3 resize-none focus:outline-none focus:ring-2 focus:ring-green-500 bg-gray-50 font-mono"
              />
            </div>

            {/* 1日の返信上限 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <label className="block font-semibold text-gray-800 mb-1">
                1人あたり1日の返信上限
              </label>
              <p className="text-xs text-gray-500 mb-3">
                コスト制御のため、友だち1人に1日何回まで返信するかを設定します。
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={dailyLimit}
                  onChange={(e) => setDailyLimit(Number(e.target.value))}
                  className="w-24 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <span className="text-sm text-gray-600">回 / 日</span>
              </div>
            </div>

            {/* 保存ボタン */}
            {error && (
              <p className="text-sm text-red-600">{error}</p>
            )}
            {saved && (
              <p className="text-sm text-green-600">保存しました</p>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full py-3 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white font-semibold rounded-xl transition-colors"
            >
              {saving ? '保存中...' : '設定を保存'}
            </button>

            <div className="text-xs text-gray-400">
              最終更新: {config.updated_at ? new Date(config.updated_at).toLocaleString('ja-JP') : '—'}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
