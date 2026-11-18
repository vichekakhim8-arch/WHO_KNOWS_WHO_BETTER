// Game/room logic shared by Local Demo and Firebase RTDB.
// All mutations go through transactions so both clients stay consistent
// (answer written once, result committed once, round advanced once).

export const ANSWER_MS = 20000;
export const REVEAL_MS = 4500;
export const AUTO_GRACE_MS = 3000;
export const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const now = () => Date.now();

export class ServiceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const roleOf = (room, uid) =>
  !room ? null : room.hostUid === uid ? 'host' : room.guestUid === uid ? 'guest' : null;

export const isExpired = (room, at = now()) => !!room && typeof room.expiresAt === 'number' && at > room.expiresAt;

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateRoomCode() {
  const bytes = new Uint8Array(6);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => CHARS[b % CHARS.length]).join('');
}

function blankRound(extra = {}, clock = now) {
  return {
    answers: { host: null, guest: null, hostAt: null, guestAt: null },
    roundResult: null,
    roundStartedAt: clock(),
    timerEndsAt: clock() + ANSWER_MS,
    ...extra,
  };
}

export class RoomService {
  constructor(backend) {
    this.backend = backend;
    this.uid = backend.uid;
    this.kind = backend.kind;
  }

  // Server-aligned clock when the transport provides one.
  now() {
    const t = this.backend?.now?.();
    return typeof t === 'number' && Number.isFinite(t) ? t : now();
  }

  roleOf(room) { return roleOf(room, this.uid); }
  isMember(room) { return this.roleOf(room) !== null; }

  // Hide the partner's answer until both are in (or the reveal is live).
  sanitize(room) {
    if (!room) return null;
    const view = clone(room);
    const role = this.roleOf(room);
    const bothIn = room.answers && room.answers.host != null && room.answers.guest != null;
    const reveal = room.phase === 'reveal' || room.status === 'finished';
    if (!reveal && !bothIn) {
      if (!role) {
        view.answers = { host: null, guest: null, hostAt: null, guestAt: null };
      } else {
        const other = role === 'host' ? 'guest' : 'host';
        view.answers = {
          host: role === 'host' ? room.answers?.host ?? null : null,
          guest: role === 'guest' ? room.answers?.guest ?? null : null,
          [`${role}At`]: room.answers?.[`${role}At`] ?? null,
          [`${other}At`]: null,
        };
      }
    }
    return view;
  }

  async getRoom(code) {
    let room;
    try {
      room = await this.backend.getRoom(code);
    } catch (err) {
      // Online mode: "permission denied" means the code is unknown or the
      // guest slot is already taken, which the UI treats as "not available".
      if (err?.code === 'PERMISSION_DENIED' || /permission/i.test(err?.message || '')) return null;
      throw err;
    }
    return isExpired(room, this.now()) ? null : room;
  }

  watchRoom(code, onRoom, onError) {
    return this.backend.watchRoom(
      code,
      (room) => onRoom(room && !isExpired(room, this.now()) ? this.sanitize(room) : null),
      onError,
    );
  }

  async createRoom({ name, avatar, photo, source, count, category, questions }) {
    let lastError = null;
    for (let i = 0; i < 6; i++) {
      const code = generateRoomCode();
      // Unreadable codes (permission denied) simply mean "not taken".
      const existing = await this.backend.getRoom(code).catch(() => null);
      if (existing) continue;
      const at = this.now();
      const room = {
        v: 2,
        code,
        createdAt: at,
        expiresAt: at + ROOM_TTL_MS,
        status: 'waiting',
        phase: 'waiting',
        hostUid: this.uid,
        guestUid: null,
        hostName: name,
        guestName: '',
        hostAvatar: avatar || '🐻',
        guestAvatar: '',
        hostPhoto: photo || '',
        guestPhoto: '',
        source,
        count,
        category: category || 'all',
        questions: clone(questions || []),
        index: 0,
        total: (questions || []).length,
        ...blankRound({ timerEndsAt: 0, roundStartedAt: 0 }, () => at),
        results: [],
        matches: 0,
        lastSeen: { host: at, guest: 0 },
      };
      try {
        await this.backend.createRoom(code, room);
        return code;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new ServiceError('conflict');
  }

  async join(code, name, avatar, photo) {
    let reason = null;
    const { committed } = await this.backend.transaction(code, (room) => {
      if (!room) { reason = 'notfound'; return undefined; }
      if (isExpired(room, this.now())) { reason = 'expired'; return undefined; }
      if (room.hostUid === this.uid) return room;
      if (room.status !== 'waiting') { reason = 'started'; return undefined; }
      if (room.guestUid && room.guestUid !== this.uid) { reason = 'full'; return undefined; }
      room.guestUid = this.uid;
      room.guestName = name;
      room.guestAvatar = avatar || '🐰';
      room.guestPhoto = photo || '';
      room.lastSeen = { ...(room.lastSeen || {}), guest: this.now() };
      return room;
    });
    if (!committed) throw new ServiceError(reason || 'conflict');
    return this.getRoom(code);
  }

  async start(code, questions) {
    let reason = null;
    const { committed } = await this.backend.transaction(code, (room) => {
      if (!room) { reason = 'notfound'; return undefined; }
      const role = roleOf(room, this.uid);
      if (role !== 'host') { reason = 'access'; return undefined; }
      if (!room.guestUid) { reason = 'waiting'; return undefined; }
      if (room.status !== 'waiting') { reason = 'started'; return undefined; }
      const set = questions && questions.length ? questions : room.questions || [];
      if (!set.length) { reason = 'empty'; return undefined; }
      const total = set.length;
      const round = blankRound({}, () => this.now());
      return {
        ...room,
        questions: clone(set),
        total,
        status: 'playing',
        phase: 'answer',
        index: 0,
        matches: 0,
        results: [],
        ...round,
        timerEndsAt: this.now() + ANSWER_MS,
      };
    });
    if (!committed) throw new ServiceError(reason || 'conflict');
  }

  async submit(code, choice, { auto = false, forRole = null } = {}) {
    let reason = null;
    const { committed } = await this.backend.transaction(code, (room) => {
      if (!room) { reason = 'notfound'; return undefined; }
      const myRole = roleOf(room, this.uid);
      if (!myRole) { reason = 'access'; return undefined; }
      const role = forRole || myRole;
      if (role !== myRole && role !== (myRole === 'host' ? 'guest' : 'host')) {
        reason = 'access'; return undefined;
      }
      if (room.status !== 'playing' || room.phase !== 'answer') { reason = 'late'; return undefined; }
      const answers = room.answers || {};
      if (answers[role] != null) { reason = 'answered'; return undefined; }
      if (auto && this.now() < (room.timerEndsAt || 0)) { reason = 'early'; return undefined; }
      const options = room.questions?.[room.index]?.options || [];
      const value = Number.isInteger(choice) ? choice : Math.floor(Math.random() * Math.max(1, options.length));
      const safe = Math.max(0, Math.min(Math.max(0, options.length - 1), value));

      const answersNext = { ...answers, [role]: safe, [`${role}At`]: this.now() };
      const bothIn = answersNext.host != null && answersNext.guest != null;
      const patch = { answers: answersNext };
      if (bothIn) {
        const match = answersNext.host === answersNext.guest;
        const roundStartedAt = room.roundStartedAt || this.now();
        patch.phase = 'reveal';
        patch.timerEndsAt = this.now() + REVEAL_MS;
        patch.roundResult = {
          index: room.index,
          host: answersNext.host,
          guest: answersNext.guest,
          match,
          hostMs: Math.max(0, (answersNext.hostAt || this.now()) - roundStartedAt),
          guestMs: Math.max(0, (answersNext.guestAt || this.now()) - roundStartedAt),
          auto: { [role]: !!auto },
        };
        patch.matches = (room.matches || 0) + (match ? 1 : 0);
      }
      return { ...room, ...patch };
    });
    if (!committed) throw new ServiceError(reason || 'conflict');
  }

  // Any member may nudge the game forward once the reveal has been shown.
  async advance(code) {
    let reason = null;
    const { committed } = await this.backend.transaction(code, (room) => {
      if (!room) { reason = 'notfound'; return undefined; }
      if (!roleOf(room, this.uid)) { reason = 'access'; return undefined; }
      if (room.status !== 'playing' || room.phase !== 'reveal') { reason = 'late'; return undefined; }
      if (!room.roundResult) { reason = 'notready'; return undefined; }
      const results = [...(room.results || [])];
      if (!results.some((r) => r.index === room.roundResult.index)) results.push(room.roundResult);
      const nextIndex = room.index + 1;
      if (nextIndex >= room.total) {
        return {
          ...room,
          results,
          status: 'finished',
          phase: 'finished',
          timerEndsAt: 0,
          roundResult: null,
          answers: { host: null, guest: null, hostAt: null, guestAt: null },
        };
      }
      const round = blankRound({}, () => this.now());
      return {
        ...room,
        ...round,
        results,
        index: nextIndex,
        phase: 'answer',
        timerEndsAt: this.now() + ANSWER_MS,
      };
    });
    if (!committed) throw new ServiceError(reason || 'conflict');
  }

  async rematch(code, questions) {
    let reason = null;
    const { committed } = await this.backend.transaction(code, (room) => {
      if (!room) { reason = 'notfound'; return undefined; }
      if (roleOf(room, this.uid) !== 'host') { reason = 'access'; return undefined; }
      if (!room.guestUid) { reason = 'waiting'; return undefined; }
      const set = questions && questions.length ? questions : room.questions || [];
      if (!set.length) { reason = 'empty'; return undefined; }
      return {
        ...room,
        status: 'playing',
        phase: 'answer',
        questions: clone(set),
        total: set.length,
        index: 0,
        matches: 0,
        results: [],
        createdAt: this.now(),
        ...blankRound({}, () => this.now()),
        timerEndsAt: this.now() + ANSWER_MS,
        lastSeen: { ...(room.lastSeen || {}), host: this.now() },
      };
    });
    if (!committed) throw new ServiceError(reason || 'conflict');
  }

  async returnToLobby(code) {
    let reason = null;
    const { committed } = await this.backend.transaction(code, (room) => {
      if (!room) { reason = 'notfound'; return undefined; }
      if (roleOf(room, this.uid) !== 'host') { reason = 'access'; return undefined; }
      if (!room.guestUid) { reason = 'waiting'; return undefined; }
      const set = room.questions?.length ? room.questions : [];
      if (!set.length) { reason = 'empty'; return undefined; }
      const at = this.now();
      return {
        ...room,
        status: 'waiting',
        phase: 'waiting',
        index: 0,
        matches: 0,
        results: [],
        createdAt: at,
        expiresAt: at + ROOM_TTL_MS,
        ...blankRound({ timerEndsAt: 0, roundStartedAt: 0 }, () => at),
        lastSeen: { ...(room.lastSeen || {}), host: at },
      };
    });
    if (!committed) throw new ServiceError(reason || 'conflict');
  }

  async leave(code) {
    const room = await this.getRoom(code);
    if (!room) return;
    const role = roleOf(room, this.uid);
    if (!role) return;
    if (role === 'host' && room.status === 'waiting') {
      await this.backend.deleteRoom(code);
      return;
    }
    if (role === 'guest' && room.status === 'waiting') {
      await this.backend.transaction(code, (cur) => {
        if (!cur || cur.guestUid !== this.uid || cur.status !== 'waiting') return undefined;
        return { ...cur, guestUid: null, guestName: '', lastSeen: { ...(cur.lastSeen || {}), guest: 0 } };
      });
    }
  }

  async ping(code) {
    await this.backend.transaction(code, (room) => {
      if (!room) return undefined;
      const role = roleOf(room, this.uid);
      if (!role) return undefined;
      return { ...room, lastSeen: { ...(room.lastSeen || {}), [role]: this.now() } };
    });
  }
}
