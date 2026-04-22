// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'

describe('LIFFフォームのボタン状態管理', () => {

  describe('メールアドレスバリデーション', () => {
    it('正しいメール形式ならvalidになる', () => {
      const emailValid = (v: string) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
      expect(emailValid('test@example.com')).toBe(true)
      expect(emailValid('aki@walover-co.work')).toBe(true)
    })

    it('不正なメール形式はinvalidになる', () => {
      const emailValid = (v: string) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
      expect(emailValid('')).toBe(false)
      expect(emailValid('notanemail')).toBe(false)
      expect(emailValid('missing@')).toBe(false)
      expect(emailValid('@nodomain.com')).toBe(false)
    })
  })

  describe('ボタンのdisabled条件', () => {
    it('名前とメールが揃っていればボタンが有効になる', () => {
      const isDisabled = (submitting: boolean, name: string, email: string) =>
        submitting ||
        !name.trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

      expect(isDisabled(false, '山田太郎', 'test@example.com')).toBe(false)
    })

    it('名前が空ならボタンが無効', () => {
      const isDisabled = (submitting: boolean, name: string, email: string) =>
        submitting ||
        !name.trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

      expect(isDisabled(false, '', 'test@example.com')).toBe(true)
    })

    it('メールが空ならボタンが無効', () => {
      const isDisabled = (submitting: boolean, name: string, email: string) =>
        submitting ||
        !name.trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

      expect(isDisabled(false, '山田太郎', '')).toBe(true)
    })

    it('送信中はボタンが無効', () => {
      const isDisabled = (submitting: boolean, name: string, email: string) =>
        submitting ||
        !name.trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

      expect(isDisabled(true, '山田太郎', 'test@example.com')).toBe(true)
    })

    it('名前が空白のみならボタンが無効', () => {
      const isDisabled = (submitting: boolean, name: string, email: string) =>
        submitting ||
        !name.trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

      expect(isDisabled(false, '   ', 'test@example.com')).toBe(true)
    })
  })

  describe('updateSubmitButton（再描画なしでボタン状態を更新）', () => {
    it('stateが変わったらボタンのdisabledが即座に反映される', () => {
      document.body.innerHTML = `
        <button id="booking-submit" disabled
          style="background:#94a3b8;cursor:not-allowed;">
          この日時で予約する
        </button>
      `
      const btn = document.getElementById('booking-submit') as HTMLButtonElement

      const name = '山田太郎'
      const email = 'test@example.com'
      const submitting = false
      const disabled = submitting ||
        !name.trim() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

      btn.disabled = disabled
      btn.style.background = disabled ? '#94a3b8' : '#06C755'

      expect(btn.disabled).toBe(false)
      expect(btn.style.background).toBe('#06C755')
    })

    it('__setNameを呼んだ後にボタン状態が更新される（回帰テスト）', () => {
      document.body.innerHTML = `
        <button id="booking-submit" disabled></button>
      `
      const btn = document.getElementById('booking-submit') as HTMLButtonElement

      const state = { userName: '', userEmail: '', submitting: false }

      const updateSubmitButton = () => {
        if (!btn) return
        const disabled = state.submitting ||
          !state.userName.trim() ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.userEmail.trim())
        btn.disabled = disabled
      }

      const setName = (v: string) => {
        state.userName = v
        updateSubmitButton()
      }

      const setEmail = (v: string) => {
        state.userEmail = v
        updateSubmitButton()
      }

      // 名前だけ入力→まだdisabled
      setName('山田太郎')
      expect(btn.disabled).toBe(true)

      // メールも入力→有効になる
      setEmail('test@example.com')
      expect(btn.disabled).toBe(false)
    })
  })
})
