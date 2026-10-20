/**
 * One-time import of Nouria's built-in lines and recordings from the web app's static files into the
 * mascot tables. Does nothing when any mascot group already exists, so it is safe to run again.
 *
 *   npx ts-node --transpile-only prisma/import-mascot.ts      (from apps/api)
 *   npm run db:import-mascot -w @workforce/api
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MascotTrigger, PrismaClient } from '@prisma/client';
import type { MascotConditions, MascotLocale, MascotMood } from '@workforce/shared';
import { AuditService } from '../src/modules/audit/audit.service';

const prisma = new PrismaClient();
const audit = new AuditService();

// Starting content for an empty database: prisma/mascot-seed (works from ts-node and from dist/prisma).
const SEED_ROOT = [join(__dirname, 'mascot-seed'), join(__dirname, '..', '..', 'prisma', 'mascot-seed')].find((d) => existsSync(d))
  ?? join(__dirname, 'mascot-seed');
const LINES_FILE = join(SEED_ROOT, 'lines-data.json');
const MANIFEST_FILE = join(SEED_ROOT, 'audio-manifest.json');
const AUDIO_DIR = join(SEED_ROOT, 'audio');
const LOCALES: MascotLocale[] = ['ar', 'en'];

interface Situation {
  key: string;
  name: string;
  description: string;
  trigger: MascotTrigger;
  conditions: MascotConditions;
  priority: number;
  moods: MascotMood[];
}

const SITUATIONS: Situation[] = [
  { key: 'greetMorning', name: 'ترحيب الصبح', description: 'Greeting before noon', trigger: 'GREETING', conditions: { timeTo: '12:00' }, priority: 0, moods: ['happy', 'wink'] },
  { key: 'greetLater', name: 'ترحيب بعد الظهر', description: 'Greeting from noon on', trigger: 'GREETING', conditions: { timeFrom: '12:00' }, priority: 0, moods: ['happy', 'wink'] },
  { key: 'checkInRestDay', name: 'حضور يوم العطلة', description: 'Check-in on a rest day or holiday', trigger: 'CHECK_IN', conditions: { workday: false }, priority: 30, moods: ['shocked'] },
  { key: 'checkInLate', name: 'حضور متأخر', description: 'Late check-in', trigger: 'CHECK_IN', conditions: { arrival: ['LATE'] }, priority: 20, moods: ['wink', 'sleepy'] },
  { key: 'checkInEarly', name: 'حضور بكّير', description: 'Early check-in (before 08:00)', trigger: 'CHECK_IN', conditions: { arrival: ['EARLY'], earlyBefore: '08:00' }, priority: 10, moods: ['shocked', 'party'] },
  { key: 'checkInOnTime', name: 'حضور عالوقت', description: 'Check-in on time', trigger: 'CHECK_IN', conditions: {}, priority: 0, moods: ['happy', 'party'] },
  { key: 'checkOutLong', name: 'انصراف بعد يوم طويل', description: 'Check-out after working an hour or more beyond the required time', trigger: 'CHECK_OUT', conditions: { workVsRequired: { min: 60 } }, priority: 30, moods: ['party'] },
  { key: 'checkOutThursday', name: 'انصراف يوم الخميس', description: 'Check-out on Thursday (weekend ahead)', trigger: 'CHECK_OUT', conditions: { weekdays: [4] }, priority: 20, moods: ['party'] },
  { key: 'checkOutShort', name: 'انصراف بكّير', description: 'Check-out two hours or more short of the required time', trigger: 'CHECK_OUT', conditions: { workVsRequired: { max: -120 } }, priority: 10, moods: ['wink', 'sad'] },
  { key: 'checkOutNormal', name: 'انصراف عادي', description: 'Regular check-out', trigger: 'CHECK_OUT', conditions: {}, priority: 0, moods: ['happy', 'wink'] },
  { key: 'lunch', name: 'بداية استراحة الغدا', description: 'Lunch break starts', trigger: 'BREAK_START', conditions: { breakTypeCodes: ['LUNCH'] }, priority: 10, moods: ['happy', 'party'] },
  { key: 'shortBreak', name: 'بداية استراحة قصيرة', description: 'Short break starts', trigger: 'BREAK_START', conditions: { breakTypeCodes: ['SHORT'] }, priority: 10, moods: ['wink', 'happy'] },
  { key: 'otherBreak', name: 'بداية استراحة ثانية', description: 'Any other break starts', trigger: 'BREAK_START', conditions: {}, priority: 0, moods: ['happy'] },
  { key: 'breakTooLong', name: 'رجوع من استراحة طوّلت', description: 'Back from a break that ran past its limit', trigger: 'BREAK_END', conditions: { breakExceeded: true }, priority: 10, moods: ['shocked', 'wink'] },
  { key: 'breakBack', name: 'رجوع من الاستراحة', description: 'Back from a break', trigger: 'BREAK_END', conditions: {}, priority: 0, moods: ['happy'] },
  { key: 'outsideOffice', name: 'برّا الشركة', description: 'Check-in / check-out refused: the device is not at the office', trigger: 'ERROR', conditions: { errorCodes: ['LOCATION_OUTSIDE_OFFICE', 'LOCATION_REQUIRED', 'LOCATION_INACCURATE'] }, priority: 10, moods: ['shocked', 'wink'] },
  { key: 'genericError', name: 'خطأ عام', description: 'Any other error', trigger: 'ERROR', conditions: {}, priority: 0, moods: ['sad'] },
  { key: 'poke', name: 'لما يدوس على نورية', description: 'The user taps Nouria', trigger: 'POKE', conditions: {}, priority: 0, moods: ['wink', 'happy', 'party'] },
];

type LinesData = Record<string, Partial<Record<MascotLocale, string[]>>>;

async function main(): Promise<void> {
  const existing = await prisma.mascotGroup.count();
  if (existing > 0) {
    console.log(`Mascot content already present (${existing} group(s)); nothing imported.`);
    return;
  }
  const lines = JSON.parse(readFileSync(LINES_FILE, 'utf8')) as LinesData;
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Record<string, string>;
  const unknown = Object.keys(lines).filter((k) => !SITUATIONS.some((s) => s.key === k));
  if (unknown.length) throw new Error(`lines-data.json has situations without a mapping: ${unknown.join(', ')}`);

  const counts = await prisma.$transaction(async (tx) => {
    let groupCount = 0;
    let lineCount = 0;
    let audioCount = 0;
    for (const [index, s] of SITUATIONS.entries()) {
      const group = await tx.mascotGroup.create({
        data: {
          name: s.name, description: s.description, trigger: s.trigger, conditions: s.conditions as object,
          priority: s.priority, moods: s.moods, isActive: true, sortOrder: index,
        },
      });
      groupCount++;
      let sortOrder = 0;
      for (const locale of LOCALES) {
        for (const [i, text] of (lines[s.key]?.[locale] ?? []).entries()) {
          const key = `${locale}/${s.key}-${i}`;
          const file = join(AUDIO_DIR, locale, `${s.key}-${i}.mp3`);
          const audio = key in manifest && existsSync(file) ? readFileSync(file) : null;
          await tx.mascotLine.create({
            data: {
              groupId: group.id, locale, text, isActive: true, sortOrder: sortOrder++,
              ...(audio && {
                audio, audioMime: 'audio/mpeg', audioSize: audio.length,
                audioSha256: createHash('sha256').update(audio).digest('hex'),
              }),
            },
          });
          lineCount++;
          if (audio) audioCount++;
        }
      }
    }
    await audit.record(tx, {
      actorUserId: null, action: 'MASCOT_IMPORT', entityType: 'MascotGroup',
      after: { groups: groupCount, lines: lineCount, linesWithAudio: audioCount, source: 'prisma/mascot-seed' },
    });
    return { groupCount, lineCount, audioCount };
  }, { timeout: 120_000, maxWait: 20_000 });

  console.log(`Imported ${counts.groupCount} group(s), ${counts.lineCount} line(s), ${counts.audioCount} with a recording.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
