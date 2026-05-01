'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import EventDetailClient from './event-detail-client'

function DetailInner() {
  const params = useSearchParams()
  const id = params.get('id')

  if (!id || isNaN(Number(id))) {
    return <div className="p-8 text-center text-gray-500">イベントIDが指定されていません</div>
  }

  return <EventDetailClient eventId={Number(id)} />
}

export default function EventDetailPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">読み込み中...</div>}>
      <DetailInner />
    </Suspense>
  )
}
