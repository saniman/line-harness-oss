'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'
import { validateTagName, DEFAULT_TAG_COLOR, getTagTextColor } from '@/lib/tags'
import Header from '@/components/layout/header'

function TagBadgeWithDelete({ tag, onDelete }: { tag: Tag; onDelete: () => void }) {
  const textColor = getTagTextColor(tag.color)
  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium"
      style={{ backgroundColor: tag.color, color: textColor }}
    >
      <span>{tag.name}</span>
      <button
        onClick={onDelete}
        className="hover:opacity-70 transition-opacity"
        aria-label={`タグ「${tag.name}」を削除`}
      >
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd"
            d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
            clipRule="evenodd" />
        </svg>
      </button>
    </div>
  )
}

export default function TagsPage() {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(DEFAULT_TAG_COLOR)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const loadTags = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.tags.list()
      if (res.success) {
        setTags(res.data)
      } else {
        setError('タグの読み込みに失敗しました')
      }
    } catch {
      setError('タグの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTags()
  }, [loadTags])

  const handleCreate = async () => {
    const validationError = validateTagName(newName)
    if (validationError) {
      setCreateError(validationError)
      return
    }
    setCreating(true)
    setCreateError('')
    try {
      const res = await api.tags.create({ name: newName.trim(), color: newColor })
      if (res.success) {
        setNewName('')
        setNewColor(DEFAULT_TAG_COLOR)
        await loadTags()
      } else {
        setCreateError('タグの作成に失敗しました')
      }
    } catch {
      setCreateError('タグの作成に失敗しました')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (tag: Tag) => {
    const confirmed = window.confirm(
      `このタグを削除すると、付与済みの友だちからも削除されます。よろしいですか？\n\nタグ名: ${tag.name}`
    )
    if (!confirmed) return
    try {
      await api.tags.delete(tag.id)
      await loadTags()
    } catch {
      setError('タグの削除に失敗しました')
    }
  }

  const isCreateDisabled = !newName.trim() || creating

  return (
    <div>
      <Header
        title="タグ管理"
        description="友だちに付与するタグを管理します"
      />

      {/* タグ作成フォーム */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">新しいタグを作成</h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setCreateError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !isCreateDisabled) handleCreate() }}
            placeholder="タグ名（例: VIP、見込み客）"
            className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[42px] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 whitespace-nowrap">カラー</label>
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer border border-gray-300"
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={isCreateDisabled}
            className="px-5 py-2 min-h-[42px] text-sm font-medium text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            style={{ backgroundColor: '#3B82F6' }}
          >
            {creating ? '作成中...' : '作成'}
          </button>
        </div>
        {createError && (
          <p className="mt-2 text-sm text-red-600">{createError}</p>
        )}
      </div>

      {/* エラー */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* タグ一覧 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">
          タグ一覧
          {!loading && <span className="ml-2 text-gray-400 font-normal">({tags.length} 件)</span>}
        </h2>

        {loading ? (
          <div className="flex flex-wrap gap-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-8 w-20 bg-gray-100 rounded-full animate-pulse" />
            ))}
          </div>
        ) : tags.length === 0 ? (
          <p className="text-sm text-gray-500">タグがありません。最初のタグを作成してください。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <TagBadgeWithDelete
                key={tag.id}
                tag={tag}
                onDelete={() => handleDelete(tag)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
