import { describe, it, expect } from 'vitest';
import { safeRedirectTarget } from './safe-redirect.js';

describe('safeRedirectTarget', () => {
  describe('安全な値はそのまま返す', () => {
    it('http(s) の絶対URLの場合はそのまま通る', () => {
      expect(safeRedirectTarget('https://example.com/lp')).toBe('https://example.com/lp');
      expect(safeRedirectTarget('http://example.com')).toBe('http://example.com');
    });

    it('ルート相対パスの場合は同一オリジンとして通る', () => {
      expect(safeRedirectTarget('/thanks')).toBe('/thanks');
      expect(safeRedirectTarget('/t/abc?x=1')).toBe('/t/abc?x=1');
    });

    it('正当なディープリンクスキームの場合は通る', () => {
      expect(safeRedirectTarget('line://ti/p/@walover')).toBe('line://ti/p/@walover');
      expect(safeRedirectTarget('tel:0120000000')).toBe('tel:0120000000');
      expect(safeRedirectTarget('mailto:info@example.com')).toBe('mailto:info@example.com');
    });

    it('前後の空白はトリムして通す', () => {
      expect(safeRedirectTarget('  https://example.com  ')).toBe('https://example.com');
    });
  });

  describe('危険な値は null を返す', () => {
    it('javascript: スキームの場合は弾く', () => {
      expect(safeRedirectTarget('javascript:alert(1)')).toBeNull();
      expect(safeRedirectTarget('JavaScript:alert(1)')).toBeNull();
    });

    it('data: / vbscript: / file: スキームの場合は弾く', () => {
      expect(safeRedirectTarget('data:text/html,<script>alert(1)</script>')).toBeNull();
      expect(safeRedirectTarget('vbscript:msgbox(1)')).toBeNull();
      expect(safeRedirectTarget('file:///etc/passwd')).toBeNull();
    });

    it('プロトコル相対 //host の場合は弾く', () => {
      expect(safeRedirectTarget('//evil.com')).toBeNull();
      expect(safeRedirectTarget('/\\evil.com')).toBeNull();
      expect(safeRedirectTarget('\\\\evil.com')).toBeNull();
    });

    it('制御文字（CR/LF等）を含む場合は弾く', () => {
      expect(safeRedirectTarget('https://example.com\r\nSet-Cookie: x=1')).toBeNull();
      expect(safeRedirectTarget('java\tscript:alert(1)')).toBeNull();
    });

    it('URLでもルート相対でもない裸の文字列の場合は弾く', () => {
      expect(safeRedirectTarget('evil.com')).toBeNull();
      expect(safeRedirectTarget('not a url')).toBeNull();
    });

    it('空・null・undefined の場合は null を返す', () => {
      expect(safeRedirectTarget('')).toBeNull();
      expect(safeRedirectTarget('   ')).toBeNull();
      expect(safeRedirectTarget(null)).toBeNull();
      expect(safeRedirectTarget(undefined)).toBeNull();
    });
  });
});
