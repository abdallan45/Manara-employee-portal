import { cleanFileName } from './leave-documents.service';

// Multer hands over the multipart filename decoded as latin1.
const asMulter = (name: string) => Buffer.from(name, 'utf8').toString('latin1');

describe('cleanFileName', () => {
  it('keeps Arabic names and fixes the extension from the sniffed type', () => {
    expect(cleanFileName(asMulter('تقرير طبي.png'), 'image/png')).toBe('تقرير طبي.png');
    expect(cleanFileName('note.jpg', 'application/pdf')).toBe('note.pdf');
  });

  it('drops path parts and control characters', () => {
    expect(cleanFileName('..\\..\\evil<>.pdf', 'application/pdf')).toBe('evil.pdf');
    expect(cleanFileName('a\u0000b\u001f.pdf', 'application/pdf')).toBe('ab.pdf');
  });

  it('strips bidi controls that disguise the real extension', () => {
    // "invoice<RLO>gpj.exe" displays as "invoiceexe.jpg".
    expect(cleanFileName(asMulter('invoice‮gpj.exe'), 'application/pdf')).toBe('invoicegpj.pdf');
    for (const ch of ['‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']) {
      expect(cleanFileName(asMulter(`a${ch}b.png`), 'image/png')).toBe('ab.png');
    }
  });

  it('falls back to "document" when nothing readable is left', () => {
    expect(cleanFileName(asMulter('‮⁦.png'), 'image/png')).toBe('document.png');
  });
});
