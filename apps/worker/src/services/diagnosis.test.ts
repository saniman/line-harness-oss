import { describe, it, expect } from 'vitest'
import {
  DIAGNOSIS_QUESTIONS,
  buildQuickReply,
  buildDiagnosisPrompt,
  getNextQuestion,
  isCompleted,
} from './diagnosis.js'

describe('DIAGNOSIS_QUESTIONS', () => {
  it('5問定義されている', () => {
    expect(DIAGNOSIS_QUESTIONS).toHaveLength(5)
  })

  it('step は 1〜5 で連番', () => {
    const steps = DIAGNOSIS_QUESTIONS.map(q => q.step)
    expect(steps).toEqual([1, 2, 3, 4, 5])
  })

  it('各質問にテキストと選択肢がある', () => {
    for (const q of DIAGNOSIS_QUESTIONS) {
      expect(q.text).toBeTruthy()
      expect(q.options.length).toBeGreaterThan(0)
    }
  })
})

describe('診断セッションの進行管理', () => {
  it('step 0 から開始 — getNextQuestion(0) は Q1 を返す', () => {
    const q = getNextQuestion(0)
    expect(q).not.toBeNull()
    expect(q!.step).toBe(1)
  })

  it('step 5 の次は null（完了）', () => {
    expect(getNextQuestion(5)).toBeNull()
  })

  it('step が 4 以下なら isCompleted は false', () => {
    expect(isCompleted(4)).toBe(false)
  })

  it('step が 5 になると isCompleted は true', () => {
    expect(isCompleted(5)).toBe(true)
  })

  it('step が 5 超でも isCompleted は true', () => {
    expect(isCompleted(6)).toBe(true)
  })
})

describe('buildQuickReply', () => {
  it('選択肢の数だけ QuickReply アイテムが生成される', () => {
    const q = DIAGNOSIS_QUESTIONS[0]
    const qr = buildQuickReply(q.options)
    expect(qr.items).toHaveLength(q.options.length)
  })

  it('各アイテムの type は action', () => {
    const qr = buildQuickReply(['A', 'B'])
    for (const item of qr.items) {
      expect(item.type).toBe('action')
    }
  })

  it('各アクションの label と text が一致する', () => {
    const qr = buildQuickReply(['飲食・カフェ', '美容・サロン'])
    expect(qr.items[0].action.label).toBe('飲食・カフェ')
    expect(qr.items[0].action.text).toBe('飲食・カフェ')
    expect(qr.items[1].action.label).toBe('美容・サロン')
  })

  it('空配列を渡しても items は空配列', () => {
    const qr = buildQuickReply([])
    expect(qr.items).toHaveLength(0)
  })
})

describe('buildDiagnosisPrompt', () => {
  const answers = {
    q1: '美容・サロン',
    q2: '2〜5人',
    q3: '予約・スケジュール管理',
    q4: '普通（調べれば使える）',
    q5: 'たまに使う',
  }

  it('5つの回答から診断プロンプトが生成される', () => {
    const prompt = buildDiagnosisPrompt(answers)
    expect(prompt).toBeTruthy()
    expect(typeof prompt).toBe('string')
  })

  it('業種が含まれる', () => {
    const prompt = buildDiagnosisPrompt(answers)
    expect(prompt).toContain('美容・サロン')
  })

  it('従業員数が含まれる', () => {
    const prompt = buildDiagnosisPrompt(answers)
    expect(prompt).toContain('2〜5人')
  })

  it('課題（最も時間のかかる業務）が含まれる', () => {
    const prompt = buildDiagnosisPrompt(answers)
    expect(prompt).toContain('予約・スケジュール管理')
  })

  it('AI利用経験が含まれる', () => {
    const prompt = buildDiagnosisPrompt(answers)
    expect(prompt).toContain('たまに使う')
  })
})
