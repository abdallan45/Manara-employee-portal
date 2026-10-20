// Schedule times are minutes after local midnight in the API and HH:MM in time inputs.

export const toHHMM = (minutes: number | null | undefined) =>
  minutes === null || minutes === undefined ? '' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function fromHHMM(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Shift length; an end before the start means the shift ends the next day. */
export const spanMinutes = (start: number, end: number) => (end - start + 1440) % 1440;
