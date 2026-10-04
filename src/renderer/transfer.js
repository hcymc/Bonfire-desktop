import { $, human, toast, status } from './ui.js';

const jobs = new Map();
const SPEED_WINDOW_MS = 3000;
let dir = '';
let tick = null;

export function setupTransfer({ initial = [], downloadDir = '' }) {
  dir = downloadDir;
  for (const evt of initial) apply(evt, { silent: true });
  for (const job of jobs.values()) mount(job);
  paintAll();
  window.bonfire.onTransfer((evt) => apply(evt));
  $('#clearFinished').addEventListener('click', clearFinished);
  tick = setInterval(paintAll, 700);
}

function apply(evt, { silent = false } = {}) {
  if (!evt?.jobId) return;
  let job = jobs.get(evt.jobId);
  if (!job) {
    job = { jobId: evt.jobId, kind: evt.kind, name: evt.name, samples: [], phase: 'started' };
    jobs.set(evt.jobId, job);
    mount(job);
  }
  Object.assign(job, {
    phase: evt.phase,
    sent: Number(evt.sent) || job.sent || 0,
    total: Number(evt.total) || job.total || 0,
    path: evt.path || job.path,
    fileId: evt.fileId ?? job.fileId,
    message: evt.message || job.message,
  });
  job.samples.push({ t: Date.now(), sent: job.sent });
  while (job.samples.length > 2 && job.samples[0].t < Date.now() - SPEED_WINDOW_MS) job.samples.shift();
  if (jobs.size > 200) {
    const oldest = [...jobs.values()].find((j) => !isActive(j));
    if (oldest) {
      oldest.el?.remove();
      jobs.delete(oldest.jobId);
    }
  }
  paint(job);
  paintSummary();

  if (silent) return;
  if (evt.phase === 'done') {
    if (evt.kind === 'download') {
      status(`已下载：${evt.name} → ${dir}`);
      toast(`下载完成：${evt.name}`, 'ok');
    } else {
      toast(`上传完成：${evt.name}`, 'ok');
    }
  } else if (evt.phase === 'error') {
    toast(`${evt.kind === 'upload' ? '上传' : '下载'}失败：${evt.message || '未知错误'}`, 'err');
  }
}

const ACTIVE = ['started', 'progress', 'resuming', 'retry'];
const isActive = (j) => ACTIVE.includes(j.phase);
const PHASE_LABEL = {
  started: '进行中',
  resuming: '续传中',
  progress: '进行中',
  retry: '重试中',
  paused: '已暂停',
  cancelled: '已取消',
  done: '完成',
  error: '失败',
};

function rateOf(job) {
  const s = job.samples;
  if (s.length < 2) return 0;
  const first = s[0];
  const last = s[s.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return 0;
  return Math.max(0, (last.sent - first.sent) / dt);
}

function speedText(job) {
  if (!isActive(job)) return '';
  const r = rateOf(job);
  return r > 200 ? `${human(r)}/s` : '—';
}

function mount(job) {
  const host = $('#transferList');
  const el = document.createElement('div');
  el.className = 'titem';
  const name = document.createElement('div');
  name.className = 'tname';
  name.textContent = `${job.kind === 'upload' ? '⬆' : '⬇'} ${job.name || ''}`;
  const speed = document.createElement('span');
  speed.className = 'tspeed num';
  const meta = document.createElement('div');
  meta.className = 'tmeta';
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);
  const acts = document.createElement('div');
  acts.className = 'row tight tacts';
  el.append(name, acts, bar, meta);
  Object.assign(job, { el, name, speed, meta, fill, acts });
  host?.appendChild(el);
}

function paint(job) {
  const { el, meta, fill, speed, acts } = job;
  if (!el) return;
  const pct = job.total ? Math.min(100, (job.sent / job.total) * 100) : 0;
  fill.style.width = `${pct.toFixed(1)}%`;
  el.classList.toggle('done', job.phase === 'done');
  el.classList.toggle('err', job.phase === 'error' || job.phase === 'cancelled');
  const bits = [PHASE_LABEL[job.phase] || job.phase];
  bits.push(job.total ? `${human(job.sent)} / ${human(job.total)}（${pct.toFixed(0)}%）` : human(job.sent));
  if (job.message) bits.push(job.message);
  const text = bits.join(' · ');
  if (meta.textContent !== text) meta.textContent = text;
  const sp = speedText(job);
  speed.classList.toggle('hidden', !sp);
  if (sp && speed.textContent !== sp) speed.textContent = sp;
  if (!speed.isConnected) el.insertBefore(speed, acts);
  paintActions(job, acts);
}

function paintActions(job, acts) {
  const want = isActive(job) ? 'cancel' : job.phase === 'done' && job.kind === 'download' && job.path ? 'open' : job.phase === 'paused' ? 'resume' : '';
  if (acts.dataset.want === want) return;
  acts.dataset.want = want;
  acts.textContent = '';
  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn sm ghost';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  if (want === 'cancel') {
    acts.appendChild(
      btn(job.kind === 'upload' ? '取消' : '停止', () => {
        if (job.kind === 'upload') window.bonfire.cancelUpload(job.jobId);
        else window.bonfire.cancelDownload(job.jobId);
      }),
    );
  } else if (want === 'open') {
    acts.append(
      btn('打开', () => window.bonfire.openDownload(job.path).catch((e) => toast(e.message, 'err'))),
      btn('位置', () => window.bonfire.revealDownload(job.path).catch((e) => toast(e.message, 'err'))),
    );
  } else if (want === 'resume') {
    acts.appendChild(
      btn('继续', () => {
        if (job.kind === 'upload') window.bonfire.addUploads({ paths: [job.jobId], folderId: null });
        else window.bonfire.startDownload({ fileId: job.fileId, name: job.name, size: job.total });
      }),
    );
  }
}

function paintAll() {
  for (const job of jobs.values()) paint(job);
  paintSummary();
}

function paintSummary() {
  const list = [...jobs.values()];
  const active = list.filter(isActive);
  const badge = $('#transferBadge');
  if (badge) {
    badge.textContent = String(active.length);
    badge.classList.toggle('hidden', !active.length);
  }
  document.body.classList.toggle('busy', active.length > 0);
  const summary = $('#transferSummary');
  if (!summary) return;
  if (!active.length) {
    const finished = list.filter((j) => j.phase === 'done').length;
    summary.textContent = finished ? `${finished} 个已完成` : '';
    return;
  }
  const rate = active.reduce((n, j) => n + rateOf(j), 0);
  const bytes = active.reduce((n, j) => n + (j.total ? j.sent / j.total : 0), 0);
  summary.textContent = `${active.length} 个进行中 · ${human(rate)}/s · 总进度 ${((bytes / active.length) * 100).toFixed(0)}%`;
}

export function clearFinished() {
  for (const [id, job] of [...jobs]) {
    if (!isActive(job)) {
      job.el?.remove();
      jobs.delete(id);
    }
  }
  paintSummary();
}
