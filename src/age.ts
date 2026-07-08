export function isAdult(birthday: [number, number, number] | null): boolean {
  if (!birthday) return true; // unknown birthday → show date, not age
  const [bYear, bMonth, bDay] = birthday;
  const now = new Date();
  let years = now.getFullYear() - bYear;
  const mDiff = now.getMonth() + 1 - bMonth;
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < bDay)) years--;
  return years >= 18;
}

export function getAge(birthday: [number, number, number] | null, now: Date): string {
  if (!birthday) return '';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);

  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0');
  const [curYear, curMonth, curDay] = [get('year'), get('month'), get('day')];
  const [bYear, bMonth, bDay] = birthday;

  let years = curYear - bYear;
  let months = curMonth - bMonth;

  if (months < 0) { years--; months += 12; }
  if (curDay < bDay) { months--; if (months < 0) { years--; months += 12; } }

  if (years === 0) return `${months} month${months !== 1 ? 's' : ''} old`;
  if (months === 0) return `${years} year${years !== 1 ? 's' : ''} old`;
  return `${years} year${years !== 1 ? 's' : ''} and ${months} month${months !== 1 ? 's' : ''} old`;
}
