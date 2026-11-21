import assert from 'node:assert/strict';
import { liveFrameJpeg } from './jpeg.js';

/** A document reader whose answers the test sets per kind (FIFO queue, falls back to the default). */
export function fakeReader(defaults = {}) {
  const queue = {};
  return {
    provider: 'test-ai',
    calls: [],
    next(kind, result) { (queue[kind] ??= []).push(result); },
    async read({ kind, branches }) {
      this.calls.push({ kind, branches });
      const r = queue[kind]?.shift() ?? defaults[kind];
      if (!r) return { status: 'failed', model: 'm', fields: {}, extras: {}, lowConfidence: [], issues: ['لا توجد قراءة'] };
      return { status: 'completed', model: 'm', lowConfidence: [], issues: [], extras: {}, ...r };
    },
  };
}

let salt = 1;
/** Open a camera session, upload one live frame, finalize. Returns the finalize response. */
export async function photograph(srv, kind, { publicId, editToken, frames = 1 } = {}) {
  const s = await srv.call('POST', '/api/camera/sessions', { editToken, json: { kind, publicId, camera: { facingMode: 'environment', width: 1920, height: 1080 } } });
  if (s.status !== 201) return s;
  for (let i = 0; i < frames; i++) {
    const up = await srv.call('POST', `/api/camera/sessions/${s.data.sessionId}/captures`, {
      body: liveFrameJpeg(1920, 1080, salt++),
      headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': s.data.captureToken, 'X-Capture-Meta': JSON.stringify({ videoWidth: 1920, videoHeight: 1080 }) },
    });
    assert.equal(up.status, 201, JSON.stringify(up.data));
  }
  return srv.call('POST', `/api/camera/sessions/${s.data.sessionId}/finalize`, { editToken, headers: { 'X-Capture-Token': s.data.captureToken } });
}

// Daily closing form for Tabuk on 19/11/2026 as written on the paper the user shared.
export const TABUK_FORM = {
  fields: { gross_sales: 456700, returns: 0, net_sales: 456700, mada: 279300, mastercard: 4500, visa: 114500, tamara: 0, tabby: 0, cash_sales: 58400,
    overage_shortage: 0, opening_cash_balance: 100000, cash_inflow: 58400, cash_outflow: 2000, closing_cash_balance: 67000 },
  extras: { branch: 'فرع تبوك', date: '2026-11-19', day_name: 'الخميس', notes: 'إيداع كاش الصندوق 4750 ريال' },
};
export const TABUK_Z = { fields: { gross_sales: 467800, discount: -10891, net_sales: 456700, cash: 58400, mada: 279300, visa: 119000 }, extras: { date: '2026-11-20' } };
export const TABUK_BANK = { fields: { mada_total: 279300, visa_total: 114500, mastercard_total: 4500 }, extras: { date: '2026-11-20' } };
