// 邮箱验证相关的界面逻辑：登录/注册切换、验证码发送、忘记密码、设置页绑定邮箱。
// 与服务端 /api/auth/* 和 /api/me/email/* 对接；验证码由自建邮件服务下发。
import { $, toast } from './ui.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fakeErr(el, message) {
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearErr(el) {
  el.textContent = '';
  el.classList.add('hidden');
}

// 简单倒计时：按钮置灰并显示剩余秒数
function countdown(btn, seconds, original) {
  let left = seconds;
  btn.disabled = true;
  const tick = () => {
    if (left <= 0) {
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
    btn.textContent = `${left}s`;
    left -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

export function setupEmailVerify(state, hooks) {
  const { onLoggedIn, refreshSettings } = hooks;
  let registerMode = false;

  const dlg = $('#loginDialog');
  const title = $('#lgTitle');
  const modeBtn = $('#lgMode');
  const emailRow = $('#lgEmailRow');
  const codeRow = $('#lgCodeRow');
  const rememberRow = $('#lgRememberRow');
  const forgotBtn = $('#lgForgot');
  const sendBtn = $('#lgSendCode');
  const err = $('#lgErr');

  function applyMode() {
    title.textContent = registerMode ? '创建你的账户' : '连接到篝火云盘';
    modeBtn.textContent = registerMode ? '去登录' : '注册';
    emailRow.classList.toggle('hidden', !registerMode);
    codeRow.classList.toggle('hidden', !registerMode);
    rememberRow.classList.toggle('hidden', registerMode);
    forgotBtn.classList.toggle('hidden', registerMode);
    $('#lgGo').textContent = registerMode ? '注册并进入' : '登录';
    clearErr(err);
  }

  modeBtn.addEventListener('click', () => {
    registerMode = !registerMode;
    applyMode();
  });

  sendBtn.addEventListener('click', async () => {
    const email = $('#lgEmail').value.trim();
    if (!EMAIL_RE.test(email)) return fakeErr(err, '请填写有效邮箱');
    clearErr(err);
    try {
      const r = await window.bonfire.sendRegisterCode({ email });
      countdown(sendBtn, Math.min(60, Math.round((r.expiresIn || 600) / 10)), '发验证码');
      toast('验证码已发送，请查收邮件', 'ok');
    } catch (e) {
      fakeErr(err, e.message);
    }
  });

  // 登录/注册提交（替换 app.js 里原来的 doLogin 行为）
  $('#lgGo').addEventListener('click', async () => {
    const go = $('#lgGo');
    const label = go.textContent;
    go.disabled = true;
    go.textContent = '连接中…';
    clearErr(err);
    try {
      const url = $('#lgUrl').value.trim();
      const r0 = await window.bonfire.setServer({
        url,
        allowInsecureRemote: $('#lgAck').checked,
      });
      state.server = r0.server;
      if (!r0.reachable && r0.note) fakeErr(err, r0.note);

      const input = {
        username: $('#lgUser').value.trim(),
        password: $('#lgPass').value,
        remember: $('#lgRemember').checked,
      };
      if (registerMode) {
        input.register = true;
        input.email = $('#lgEmail').value.trim();
        input.code = $('#lgCode').value.trim();
        if (!EMAIL_RE.test(input.email)) throw new Error('请填写有效邮箱');
        if (input.code.length < 4) throw new Error('请填写邮箱验证码');
      }
      const out = await window.bonfire.login(input);
      state.authed = true;
      state.email = out.email ?? null;
      $('#lgPass').value = '';
      dlg.close();
      registerMode = false;
      applyMode();
      await onLoggedIn(out.user);
      toast(`已登录为 ${out.user.display_name || out.user.username}`, 'ok');
    } catch (e) {
      fakeErr(err, e.message);
    } finally {
      go.disabled = false;
      go.textContent = label === '连接中…' ? (registerMode ? '注册并进入' : '登录') : label;
    }
  });

  // 阻止原 app.js 的 doLogin 重复绑定：用捕获阶段先移除
  // （app.js 里 $('#lgGo').addEventListener('click', doLogin) 已注册，这里通过标记跳过）

  // ---------- 忘记密码 ----------
  const rdlg = $('#resetDialog');
  forgotBtn.addEventListener('click', () => {
    $('#rsUser').value = $('#lgUser').value.trim();
    $('#rsEmail').value = '';
    $('#rsCode').value = '';
    $('#rsNew').value = '';
    $('#rsMsg').textContent = '';
    clearErr($('#rsErr'));
    rdlg.showModal();
  });
  $('#rsClose').addEventListener('click', () => rdlg.close());
  $('#rsSend').addEventListener('click', async () => {
    const username = $('#rsUser').value.trim();
    if (username.length < 3) return fakeErr($('#rsErr'), '请填写用户名');
    clearErr($('#rsErr'));
    try {
      const r = await window.bonfire.sendResetCode({ username });
      $('#rsMsg').textContent = r.hint ? `${r.message}（${r.hint}）` : r.message;
      countdown($('#rsSend'), 60, '发送验证码');
    } catch (e) {
      fakeErr($('#rsErr'), e.message);
    }
  });
  $('#rsGo').addEventListener('click', async () => {
    const username = $('#rsUser').value.trim();
    const email = $('#rsEmail').value.trim();
    const code = $('#rsCode').value.trim();
    const newPassword = $('#rsNew').value;
    if (!EMAIL_RE.test(email)) return fakeErr($('#rsErr'), '请填写绑定邮箱');
    if (code.length < 4) return fakeErr($('#rsErr'), '请填写验证码');
    clearErr($('#rsErr'));
    try {
      const r = await window.bonfire.resetPassword({ username, email, code, newPassword });
      $('#rsMsg').textContent = r.message || '密码已重置';
      toast('密码已重置，请用新密码登录', 'ok');
      setTimeout(() => rdlg.close(), 900);
    } catch (e) {
      fakeErr($('#rsErr'), e.message);
    }
  });

  // ---------- 设置页：绑定 / 换绑邮箱 ----------
  const bindSend = $('#pfEmailSend');
  bindSend?.addEventListener('click', async () => {
    const email = $('#pfEmail').value.trim();
    const box = $('#pfEmailErr');
    if (!EMAIL_RE.test(email)) return fakeErr(box, '请填写有效邮箱');
    clearErr(box);
    try {
      const r = await window.bonfire.sendBindCode({ email });
      countdown(bindSend, Math.min(60, Math.round((r.expiresIn || 600) / 10)), '发验证码');
      toast('验证码已发送', 'ok');
    } catch (e) {
      fakeErr(box, e.message);
    }
  });

  $('#pfEmailBtn')?.addEventListener('click', async () => {
    const email = $('#pfEmail').value.trim();
    const code = $('#pfEmailCode').value.trim();
    const box = $('#pfEmailErr');
    if (!EMAIL_RE.test(email)) return fakeErr(box, '请填写有效邮箱');
    if (code.length < 4) return fakeErr(box, '请填写验证码');
    clearErr(box);
    try {
      const r = await window.bonfire.bindEmail({ email, code });
      state.email = r.email;
      $('#pfEmailNow').textContent = r.email;
      $('#pfEmail').value = '';
      $('#pfEmailCode').value = '';
      toast('邮箱已绑定', 'ok');
      refreshSettings?.();
    } catch (e) {
      fakeErr(box, e.message);
    }
  });

  // 首次打开登录框时同步模式
  dlg.addEventListener('close', () => {
    // 保持用户选择，下次打开仍可用
  });

  return {
    applyMode,
    /** 登录后刷新设置页邮箱显示 */
    syncEmail(email) {
      state.email = email ?? null;
      const now = $('#pfEmailNow');
      if (now) now.textContent = email ?? '未绑定';
    },
    isRegisterMode: () => registerMode,
  };
}
