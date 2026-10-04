import { $, previewKind, human, toast } from './ui.js';

let items = [];
let idx = -1;
let seq = 0; // a slow response for the previous item must not paint over the new one

export function previewable(item) {
  return !item.isFolder && !!previewKind(item.name);
}

export function setupPreview() {
  const dlg = $('#previewDialog');
  $('#pvClose').addEventListener('click', () => dlg.close());
  $('#pvPrev').addEventListener('click', () => step(-1));
  $('#pvNext').addEventListener('click', () => step(1));
  $('#pvRetry').addEventListener('click', () => show(items[idx]));
  $('#pvDownload').addEventListener('click', () => {
    const it = items[idx];
    if (it) window.bonfire.startDownload({ fileId: it.id, name: it.name, size: it.size }).catch((e) => toast(e.message, 'err'));
  });
  // decoding a detached <video> otherwise.
  dlg.addEventListener('close', () => {
    $('#pvBody').textContent = '';
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'Escape') {
      // Explicit, so closing never depends on the native cancel default.
      e.preventDefault();
      dlg.close();
    }
  });
}

function step(delta) {
  if (!items.length) return;
  idx = (idx + delta + items.length) % items.length;
  show(items[idx]);
}

export function openPreview(item, list = []) {
  const pool = list.filter(previewable);
  const at = pool.findIndex((x) => x.id === item.id);
  items = at === -1 ? [item] : pool;
  idx = Math.max(0, at);
  show(items[idx]);
  $('#previewDialog').showModal();
}

const LABEL = { image: '图片', video: '视频', audio: '音频', pdf: 'PDF', text: '文本' };

function show(item) {
  if (!item) return;
  const mine = ++seq;
  const kind = previewKind(item.name) || 'text';
  const multi = items.length > 1;

  $('#pvRetry').classList.add('hidden');
  $('#pvName').textContent = item.name;
  $('#pvName').title = item.name;
  $('#pvMeta').textContent = `${human(item.size)} · ${LABEL[kind] || '文件'}${multi ? ` · ${idx + 1}/${items.length}` : ''}`;
  $('#pvPrev').classList.toggle('hidden', !multi);
  $('#pvNext').classList.toggle('hidden', !multi);

  const body = $('#pvBody');
  body.textContent = '';
  $('#pvFoot').textContent = '';

  const url = window.bonfire.mediaUrl({ kind: 'preview', id: item.id });

  if (kind === 'image') {
    const sk = document.createElement('div');
    sk.className = 'sk';
    const img = document.createElement('img');
    img.alt = item.name;
    img.decoding = 'async';
    img.addEventListener('load', () => {
      if (mine === seq) sk.remove();
    });
    img.addEventListener('error', () => {
      if (mine === seq) fail('图片读取失败：服务端按字节判定类型，扩展名与内容不符时不会内联渲染。');
    });
    body.append(sk, img);
    url.then((u) => {
      img.src = u;
    });
  } else if (kind === 'video') {
    const v = document.createElement('video');
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.addEventListener('error', () => {
      if (mine === seq) fail('这个视频浏览器放不了，试试下载。');
    });
    body.appendChild(v);
    url.then((u) => {
      v.src = u;
    });
  } else if (kind === 'audio') {
    const wrap = document.createElement('div');
    wrap.className = 'lb-audio';
    const disc = document.createElement('div');
    disc.className = 'lb-disc';
    const i = document.createElement('i');
    i.className = 'i i-audio';
    disc.appendChild(i);
    const a = document.createElement('audio');
    a.controls = true;
    a.preload = 'metadata';
    a.addEventListener('error', () => {
      if (mine === seq) fail('这个音频浏览器放不了，试试下载。');
    });
    wrap.append(disc, a);
    body.appendChild(wrap);
    url.then((u) => {
      a.src = u;
    });
  } else if (kind === 'pdf') {
    const f = document.createElement('iframe');
    f.title = item.name;
    body.appendChild(f);
    url.then((u) => {
      f.src = u;
    });
  } else {
    const pre = document.createElement('pre');
    const sk = document.createElement('div');
    sk.className = 'sk';
    body.append(sk, pre);
    window.bonfire
      .fileText(item.id)
      .then((text) => {
        if (mine !== seq) return;
        sk.remove();
        pre.textContent = text; // textContent, never innerHTML
      })
      .catch((err) => {
        if (mine !== seq) return;
        fail(err.message || '文本读取失败');
      });
  }
}

function fail(message) {
  const body = $('#pvBody');
  body.textContent = '';
  const card = document.createElement('div');
  card.className = 'lb-error';
  const i = document.createElement('i');
  i.className = 'i i-warn';
  const p = document.createElement('div');
  p.textContent = message;
  card.append(i, p);
  body.appendChild(card);
  $('#pvRetry').classList.remove('hidden');
  toast(message, 'err');
}
