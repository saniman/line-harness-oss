'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// 旧 GCal 予約一覧。/reservations（フィルタ＋キャンセル機能あり）に統合済み。
export default function BookingsRedirectPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/reservations')
  }, [router])

  return (
    <div className="min-h-[40vh] flex items-center justify-center text-sm text-gray-500">
      予約管理ページへ移動しています…
    </div>
  )
}
