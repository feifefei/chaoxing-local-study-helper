// ==UserScript==
// @name         学习通本地学习助手
// @namespace    local.chaoxing.study-helper
// @version      0.8.0
// @description  本地媒体控制、播放中弹题与章节测验的 DeepSeek 辅助
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        https://mooc1.chaoxing.com/mooc-ans/knowledge/*
// @match        https://mooc1.chaoxing.com/mooc-ans/work/*
// @match        https://mooc1.chaoxing.com/ananas/modules/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// ==/UserScript==

(() => {
  'use strict';

  document.documentElement.dataset.cxLocalHelperVersion = '0.8.0';

  const STORE = 'cx-local-helper-bank-v1';
  const OPTIONS = 'cx-local-helper-options-v1';
  const POSITION = 'cx-local-helper-position-v1';
  const AI_CACHE = 'cx-local-helper-ai-cache-v1';
  const FLOW_KEY = 'cx-local-helper-flow-v1';
  const SUBMIT_KEY = 'cx-local-helper-submit-attempt-v1';
  const API_KEY = 'cx-local-helper-deepseek-key-v1';
  const API_URL = 'https://api.deepseek.com/chat/completions';
  const DEFAULT_OPTIONS = { mute: true, autoNextMedia: true, autoAskQuestions: true,
    autoFillSuggestions: true, autoPopupQuestions: true };
  let bank = readStore(STORE, {});
  let preferences = { ...DEFAULT_OPTIONS, ...readStore(OPTIONS, {}) };
  let positions = readStore(POSITION, {});
  let aiCache = readStore(AI_CACHE, {});
  let panel;
  let panelHost;
  let panelKinds = '';
  let status;
  let questionList;
  let mediaList;
  let lastSignature = '';
  let aiMenuReady = false;
  const autoAsked = new Set();
  const activeRequests = new Set();
  const aiErrors = new Map();
  const autoQueue = [];
  let autoWorking = false;
  let flowQuizTimer;
  let flowButton;
  let mediaFirstButton;
  let flowMediaAttempted = new WeakSet();
  let flowEndAnnounced = false;
  let mediaPermissionTimer;
  let quizSubmitting = false;
  let popupBusy = false;
  let popupLastSignature = '';
  let popupLastFailure = '';
  let popupBadge;

  function flowState() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(FLOW_KEY) || 'null');
      return saved?.expiresAt > Date.now() ? saved : null;
    } catch { return null; }
  }

  function isFlowOn() {
    return !!flowState();
  }

  function updateFlow(patch) {
    const current = flowState();
    if (!current) return;
    sessionStorage.setItem(FLOW_KEY, JSON.stringify({ ...current, ...patch }));
  }

  function mediaFirstPhase() {
    const flow = flowState();
    return flow?.mode === 'media-first' && flow.phase === 'media';
  }

  function completedChapterInMediaFirstQuiz() {
    const flow = flowState();
    if (flow?.mode !== 'media-first' || flow.phase !== 'quiz') return false;
    const id = new URLSearchParams(location.search).get('knowledgeid');
    try { return !!id && !!window.top.document.querySelector(`#cur${id} .icon_Completed`); }
    catch { return false; }
  }

  function isMediaModule() {
    return /\/ananas\/modules\/(video|audio)\//.test(location.pathname);
  }

  function announceFlow(type, detail = '') {
    if (window === window.top) return;
    window.top.postMessage({ source: 'cx-local-helper-flow', type, detail }, location.origin);
  }

  function stopFlow(reason) {
    sessionStorage.removeItem(FLOW_KEY);
    if (flowQuizTimer) clearTimeout(flowQuizTimer);
    if (mediaPermissionTimer) clearTimeout(mediaPermissionTimer);
    if (flowButton) flowButton.textContent = '开始连续学习';
    if (mediaFirstButton) mediaFirstButton.textContent = '先看完媒体再做测验';
    message(reason);
    announceFlow('stopped', reason);
  }

  function startFlow(mode = 'chapter') {
    sessionStorage.setItem(FLOW_KEY, JSON.stringify({
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      mode, phase: mode === 'media-first' ? 'media' : 'chapter'
    }));
    if (flowButton) flowButton.textContent = '停止连续学习';
    if (mediaFirstButton) mediaFirstButton.textContent = '停止连续学习';
    message(mode === 'media-first'
      ? '先看完本课程媒体，再逐节处理测验；测验会自动提交。'
      : '连续学习已启动；会自动提交测验。');
    announceFlow('started');
    if (isMediaModule()) startFlowMedia();
    if (questionNodes().length && !mediaFirstPhase()) {
      queueAutomaticQuestions();
      scheduleFlowQuiz();
    }
  }

  function readStore(key, fallback) {
    try {
      const value = GM_getValue(key, fallback);
      return value && typeof value === 'object' ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStore(key, value) {
    GM_setValue(key, value);
  }

  function registerAIMenu() {
    if (aiMenuReady) return;
    aiMenuReady = true;
    GM_registerMenuCommand('设置 DeepSeek API Key', setKeyFromPrompt);
    GM_registerMenuCommand('清除 DeepSeek API Key', () => {
      GM_setValue(API_KEY, '');
      message('DeepSeek Key 已清除。');
    });
  }

  function setKeyFromPrompt() {
    // Browser prompt does not put the key into the learning page's DOM.
    const key = prompt('输入 DeepSeek API Key。仅保存在 Tampermonkey 脚本存储中，并发送到 api.deepseek.com：');
    if (key === null) return;
    const trimmed = key.trim();
    if (trimmed) {
      GM_setValue(API_KEY, trimmed);
      message('DeepSeek Key 已保存。');
      queueAutomaticQuestions();
    }
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, handler) {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }

  function message(text) {
    if (status) status.textContent = text;
  }

  function questionNodes() {
    return [...document.querySelectorAll('.singleQuesId[id^="question"], .questionLi[id^="question"]')]
      .filter(node => /^question\d+$/.test(node.id));
  }

  function questionInfo(node) {
    const id = node.id.slice('question'.length);
    const choices = [...node.querySelectorAll('li[qid] .num_option[data], li[qid] .num_option_dx[data]')];
    const kindText = node.querySelector('.Zy_TItle, .newZy_TItle')?.textContent || node.textContent || '';
    const type = /多选/.test(kindText) ? 'multi' : /单选|判断/.test(kindText) ? 'single' : 'other';
    return { id, node, choices, type };
  }

  function answerLetters(raw) {
    const cleaned = String(raw || '').toUpperCase().replace(/[\s,，;；|/]/g, '');
    if (!/^[A-H]+$/.test(cleaned)) return '';
    return [...new Set(cleaned)].sort().join('');
  }

  function choiceLetter(choice) {
    const label = String(choice.textContent || '').trim().toUpperCase();
    if (/^[A-H]$/.test(label)) return label;
    return answerLetters(choice.getAttribute('data'));
  }

  function selectedLetters(info) {
    const hidden = info.node.querySelector(`#answer${info.id}`);
    const value = String(hidden?.value || '').trim().toLowerCase();
    const fromHidden = value === 'true' ? 'A' : value === 'false' ? 'B' : answerLetters(value);
    if (fromHidden) return fromHidden;
    const selected = info.choices
      .filter(choice => /(^|\s)(on|active|selected|checked)(\s|$)/i.test(choice.className)
        || /(^|\s)(on|active|selected|checked)(\s|$)/i.test(choice.closest('li')?.className || ''))
      .map(choiceLetter);
    return answerLetters(selected.join(''));
  }

  function saveAnswer(info, raw) {
    const answer = answerLetters(raw);
    const valid = answer && (info.type === 'multi' || answer.length === 1)
      && [...answer].every(letter => info.choices.some(choice => choiceLetter(choice) === letter));
    if (!valid || info.type === 'other') {
      message(`题目 ${info.id}：请填有效的选项字母；当前版本支持单选、多选和判断题。`);
      return false;
    }
    bank[info.id] = { answer, type: info.type };
    writeStore(STORE, bank);
    message(`题目 ${info.id} 的答案 ${answer} 已保存在本机。`);
    renderQuestions();
    return true;
  }

  function fillAnswer(info, answer) {
    if (info.type === 'other') return false;
    const wanted = answerLetters(answer);
    if (!wanted || (info.type !== 'multi' && wanted.length !== 1)) return false;
    if (![...wanted].every(letter => info.choices.some(choice => choiceLetter(choice) === letter))) return false;

    if (info.type === 'single') {
      if (selectedLetters(info) === wanted) return true;
      info.choices.find(choice => choiceLetter(choice) === wanted).closest('li').click();
      return selectedLetters(info) === wanted;
    }

    // The platform's multi-choice handler toggles a clicked option. Read the
    // hidden answer field before each click so existing selections are kept.
    for (const letter of 'ABCDEFGH') {
      const choice = info.choices.find(item => choiceLetter(item) === letter);
      if (!choice) continue;
      const current = selectedLetters(info);
      if (wanted.includes(letter) !== current.includes(letter)) choice.closest('li').click();
    }
    return selectedLetters(info) === wanted;
  }

  function fillCachedSuggestions() {
    if (!preferences.autoFillSuggestions && !isFlowOn()) return;
    for (const node of questionNodes()) {
      const info = questionInfo(node);
      const cached = aiCache[info.id];
      if (!cached || cached.signature !== questionSignature(info) || selectedLetters(info)) continue;
      fillAnswer(info, cached.suggestion.answer);
    }
  }

  function fillSavedAnswers() {
    let filled = 0;
    let missing = 0;
    let failed = 0;
    for (const node of questionNodes()) {
      const info = questionInfo(node);
      const saved = bank[info.id];
      if (!saved) { missing++; continue; }
      if (fillAnswer(info, saved.answer)) filled++;
      else failed++;
    }
    message(`已填选 ${filled} 题；本地无答案 ${missing} 题；未能填选 ${failed} 题。请核对后自行保存或提交。`);
    renderQuestions();
  }

  function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function currentFontRule() {
    const rules = [...document.querySelectorAll('style')]
      .flatMap(style => style.textContent.match(/@font-face\s*\{[^}]*\}/g) || []);
    return rules.find(rule => rule.includes('font-cxsecret') && rule.includes('data:')) || '';
  }

  function questionContent(info) {
    const titleNode = info.node.querySelector('.fontLabel') ||
      info.node.querySelector('.mark_name, .Zy_TItle');
    const optionNodes = info.choices.map(choice => choice.closest('li')?.querySelector('.after'));
    const title = titleNode?.textContent?.trim() || '';
    const optionTexts = optionNodes.map(node => node?.textContent?.trim() || '');
    return { titleNode, optionNodes, title, optionTexts };
  }

  function questionSignature(info) {
    const { titleNode, optionNodes, title, optionTexts } = questionContent(info);
    return JSON.stringify([info.type, title, optionTexts,
      [titleNode, ...optionNodes].flatMap(node =>
        [...(node?.querySelectorAll('img, svg, canvas') || [])].map(image => image.outerHTML))]);
  }

  async function renderQuestionImage(info) {
    const { titleNode, optionNodes, title, optionTexts } = questionContent(info);
    const options = info.choices.map((choice, index) => `${choiceLetter(choice)}. ${optionTexts[index]}`);
    if (!title || !options.length || optionTexts.some(text => !text) ||
      [titleNode, ...optionNodes].some(node => node?.querySelector('img, svg, canvas'))) {
      throw new Error('当前题包含图片或缺少题干、选项，暂不发送。');
    }

    const encrypted = !!info.node.querySelector('.font-cxsecret');
    if (encrypted && !currentFontRule()) {
      throw new Error('未找到页面加密字体，无法准确生成题目图片。');
    }
    if (encrypted) {
      const faces = await document.fonts.load('26px "font-cxsecret"', `${title} ${optionTexts.join(' ')}`);
      if (!faces.length) throw new Error('页面加密字体未加载，已停止请求。');
    }

    const width = 1000;
    const margin = 38;
    const lineHeight = 39;
    const font = encrypted ? '26px "font-cxsecret", sans-serif' : '26px sans-serif';
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    function wrap(value) {
      const lines = [];
      let line = '';
      for (const char of Array.from(value.replace(/\s+/g, ' ').trim())) {
        if (line && measure.measureText(line + char).width > width - margin * 2) {
          lines.push(line);
          line = char;
        } else line += char;
      }
      if (line) lines.push(line);
      return lines;
    }
    const titleLines = wrap(title);
    const optionLines = options.map(wrap);
    const height = margin * 2 + lineHeight * (titleLines.length +
      optionLines.reduce((total, lines) => total + lines.length + 1, 0) + 1);
    if (height > 2400) throw new Error('题目太长，无法完整生成单题图片。');

    function draw(family) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#111';
      context.textBaseline = 'top';
      context.font = family;
      let y = margin;
      for (const line of titleLines) { context.fillText(line, margin, y); y += lineHeight; }
      y += lineHeight;
      for (const lines of optionLines) {
        for (const line of lines) { context.fillText(line, margin, y); y += lineHeight; }
        y += lineHeight;
      }
      return canvas;
    }

    try {
      const canvas = draw(font);
      if (encrypted) {
        const actual = canvas.getContext('2d').getImageData(0, 0, width, height).data;
        const fallback = draw('26px sans-serif').getContext('2d').getImageData(0, 0, width, height).data;
        let changed = 0;
        for (let index = 0; index < actual.length; index += 16) {
          if (Math.abs(actual[index] - fallback[index]) > 20) changed++;
        }
        if (changed < 80) throw new Error('浏览器未能在题图中显示加密字体，已停止请求。');
      }
      return canvas.toDataURL('image/png');
    } catch (error) {
      if (error?.name === 'SecurityError') throw new Error('浏览器禁止读取题图，已停止请求。');
      throw error;
    }
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function requestDeepSeek(payload, key, onRetry = () => {}) {
    const waits = [2000, 4000, 8000, 16000, 30000,
      60000, 60000, 60000, 60000, 60000, 60000];
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      try {
        return await new Promise((resolve, reject) => GM_xmlhttpRequest({
          method: 'POST', url: API_URL, anonymous: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          data: JSON.stringify(payload), timeout: 45000,
          onload: response => {
            if (response.status === 200) return resolve(response.responseText);
            const error = new Error(`DeepSeek HTTP ${response.status}`);
            error.retryable = [429, 500, 502, 503, 504].includes(response.status);
            reject(error);
          },
          onerror: () => reject(Object.assign(new Error('网络请求失败'), { retryable: true })),
          ontimeout: () => reject(Object.assign(new Error('请求超时'), { retryable: true }))
        }));
      } catch (error) {
        if (!error.retryable || attempt === waits.length) throw error;
        onRetry(`${error.message}，${Math.ceil(waits[attempt] / 1000)} 秒后重试（${attempt + 1}/${waits.length}）`);
        await delay(waits[attempt]);
      }
    }
  }

  async function callDeepSeek(imageUrl, info, key, retry = false) {
    const kind = info.type === 'multi' ? '多选题' : '单选或判断题';
    const payload = {
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: '你是答题助手。请阅读图片中的中文题目和选项，按题干实际措辞独立判断。不要将事实判断改写成道德要求。仅输出 JSON 对象，格式为 {"answer":"A或AB","reason":"一句简短理由"}。answer 只能包含选项字母 A-H。若看不清或不能确定，answer 设为空字符串。' },
        { role: 'user', content: [
          { type: 'text', text: `请解答这道${kind}。图片只包含这一题；不要推测看不清的文字。` },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
        ] }
      ],
      response_format: { type: 'json_object' },
      reasoning_effort: 'none',
      temperature: 0,
      max_tokens: retry ? 600 : 300
    };
    const responseText = await requestDeepSeek(payload, key, progress => message(`题目 ${info.id}：${progress}`));
    try {
      const body = JSON.parse(responseText);
      const content = String(body.choices?.[0]?.message?.content || '').trim();
      const clean = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(clean);
      const answer = answerLetters(parsed.answer);
      if (!answer || (info.type !== 'multi' && answer.length !== 1) ||
        ![...answer].every(letter => info.choices.some(choice => choiceLetter(choice) === letter))) {
        throw new Error('模型未给出有效的选项字母');
      }
      return { answer, reason: String(parsed.reason || '').slice(0, 180) };
    } catch {
      throw new Error('模型未返回有效的 JSON 选项。');
    }
  }

  async function askAI(info, trigger) {
    if (activeRequests.has(info.id)) {
      message(`题目 ${info.id} 正在请求中。`);
      return;
    }
    const key = GM_getValue(API_KEY, '');
    if (!key) {
      message('请先在 Tampermonkey 菜单中设置 DeepSeek API Key。');
      return;
    }
    activeRequests.add(info.id);
    if (trigger) trigger.disabled = true;
    message(`正在生成题目 ${info.id} 的图片…`);
    try {
      const imageUrl = await renderQuestionImage(info);
      message(`题目 ${info.id} 的图片将发往 api.deepseek.com，正在请求…`);
      let suggestion;
      try {
        suggestion = await callDeepSeek(imageUrl, info, key);
      } catch (error) {
        if (error.message !== '模型未返回有效的 JSON 选项。') throw error;
        message(`题目 ${info.id} 的回复格式无效，正在重试一次…`);
        suggestion = await callDeepSeek(imageUrl, info, key, true);
      }
      aiCache[info.id] = { signature: questionSignature(info), suggestion };
      writeStore(AI_CACHE, aiCache);
      aiErrors.delete(info.id);
      const selected = selectedLetters(info);
      const filled = (preferences.autoFillSuggestions || isFlowOn()) && !selected
        ? fillAnswer(info, suggestion.answer) : false;
      renderQuestions();
      message(`题目 ${info.id}：AI 建议 ${suggestion.answer}${filled ? '，已自动填选' :
        selected ? '；已有人工选择，未覆盖' : '；请人工核对'}。`);
    } catch (error) {
      aiErrors.set(info.id, error.message);
      autoAsked.delete(`${info.id}:${questionSignature(info)}`);
      renderQuestions();
      message(`题目 ${info.id}：${error.message}`);
    } finally {
      activeRequests.delete(info.id);
      if (trigger) trigger.disabled = false;
    }
  }

  function queueAutomaticQuestions() {
    if (mediaFirstPhase() || completedChapterInMediaFirstQuiz() ||
      !(preferences.autoAskQuestions || isFlowOn()) ||
      !questionList || !GM_getValue(API_KEY, '')) return;
    for (const node of questionNodes()) {
      const info = questionInfo(node);
      const signature = questionSignature(info);
      if (aiCache[info.id]?.signature === signature) continue;
      const requestId = `${info.id}:${signature}`;
      if (autoAsked.has(requestId)) continue;
      autoAsked.add(requestId);
      autoQueue.push({ id: info.id, signature });
    }
    processAutoQueue();
  }

  async function processAutoQueue() {
    if (autoWorking) return;
    autoWorking = true;
    try {
      while (!mediaFirstPhase() && !completedChapterInMediaFirstQuiz() &&
        (preferences.autoAskQuestions || isFlowOn()) && autoQueue.length) {
        const { id, signature } = autoQueue.shift();
        const node = document.getElementById(`question${id}`);
        if (!node) continue;
        const info = questionInfo(node);
        if (questionSignature(info) !== signature || aiCache[id]?.signature === signature) continue;
        await askAI(info);
      }
    } finally {
      autoWorking = false;
      scheduleFlowQuiz();
    }
  }

  function scheduleFlowQuiz() {
    if (!isFlowOn() || mediaFirstPhase() || completedChapterInMediaFirstQuiz() ||
      quizSubmitting || !questionNodes().length) return;
    clearTimeout(flowQuizTimer);
    const signature = questionNodes().map(node => `${node.id}:${questionSignature(questionInfo(node))}`).join('|');
    announceFlow('quiz-ready');
    flowQuizTimer = setTimeout(() => completeFlowQuiz(signature), 2000);
  }

  function completeFlowQuiz(expectedSignature) {
    if (!isFlowOn() || mediaFirstPhase() || quizSubmitting || autoWorking || autoQueue.length) return;
    const infos = questionNodes().map(questionInfo);
    const signature = infos.map(info => `${info.node.id}:${questionSignature(info)}`).join('|');
    if (!infos.length || signature !== expectedSignature) return;
    if (infos.some(info => info.type === 'other' || !info.choices.length)) {
      stopFlow('有不支持的题型或选项，连续学习已停止。');
      return;
    }
    if (infos.some(info => aiErrors.has(info.id))) {
      stopFlow('有题目的 AI 请求失败，连续学习已停止，请检查题目。');
      return;
    }
    if (infos.some(info => aiCache[info.id]?.signature !== questionSignature(info))) {
      if (!GM_getValue(API_KEY, '')) stopFlow('缺少 DeepSeek Key，连续学习已停止。');
      return;
    }
    for (const info of infos) {
      if (!fillAnswer(info, aiCache[info.id].suggestion.answer)) {
        stopFlow(`题目 ${info.id} 未能准确填选，连续学习已停止。`);
        return;
      }
    }
    const submit = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], a.btnSubmit')]
      .find(node => (node.textContent || node.value || '').trim() === '提交' && !node.disabled);
    if (!submit) {
      stopFlow('未找到可用的测验提交按钮，连续学习已停止。');
      return;
    }
    const attemptId = `${location.pathname}:${infos.map(info => info.id).join(',')}`;
    if (sessionStorage.getItem(SUBMIT_KEY) === attemptId) {
      stopFlow('这份测验已有一次自动提交记录，连续学习已停止，避免重复提交。');
      return;
    }
    sessionStorage.setItem(SUBMIT_KEY, attemptId);
    quizSubmitting = true;
    message(`已填选 ${infos.length} 题，正在提交并等待任务点完成。`);
    submit.click();
    announceFlow('quiz-submitted');
  }

  async function previewQuestion(info, trigger, row) {
    trigger.disabled = true;
    message(`正在本机生成题目 ${info.id} 的预览…`);
    try {
      const imageUrl = await renderQuestionImage(info);
      row.querySelector('.preview')?.remove();
      const preview = element('img');
      preview.className = 'preview';
      preview.src = imageUrl;
      preview.alt = `题目 ${info.id} 的本地预览`;
      row.append(preview);
      message(`题目 ${info.id} 的预览已生成；没有发送到 DeepSeek。`);
    } catch (error) {
      message(`题目 ${info.id}：${error.message}`);
    } finally {
      trigger.disabled = false;
    }
  }

  function renderQuestions() {
    if (!questionList) return;
    questionList.replaceChildren();
    const questions = questionNodes().map(questionInfo);
    if (!questions.length) return;
    for (const [index, info] of questions.entries()) {
      const row = element('div', undefined, 'row');
      const selected = selectedLetters(info);
      const label = element('span', `${index + 1}. ${info.type === 'multi' ? '多选' : info.type === 'single' ? '单选/判断' : '其他'} · ID ${info.id}${selected ? ` · 已选 ${selected}` : ' · 未选'}`);
      const input = element('input');
      input.type = 'text';
      input.maxLength = 8;
      input.placeholder = info.type === 'multi' ? '如 ABD' : '如 A';
      input.value = bank[info.id]?.answer || '';
      input.setAttribute('aria-label', `题目 ${info.id} 的本地答案`);
      row.append(label, input,
        button('保存', () => saveAnswer(info, input.value)),
        button('记当前选择', () => {
          const selected = selectedLetters(info);
          if (selected) saveAnswer(info, selected);
          else message(`题目 ${info.id} 尚未选择答案。`);
        }),
        button('预览题图', event => previewQuestion(info, event.currentTarget, row)),
        button('AI 建议', event => askAI(info, event.currentTarget)));
      const cached = aiCache[info.id];
      const suggestion = cached?.signature === questionSignature(info) ? cached.suggestion : null;
      if (suggestion) {
        row.append(element('span', `建议 ${suggestion.answer}：${suggestion.reason}`),
          button('填入建议', () => {
            message(fillAnswer(info, suggestion.answer)
              ? `题目 ${info.id} 已填入 AI 建议，请核对。`
              : `题目 ${info.id} 未能填入，需人工选择。`);
          }));
      }
      else if (aiErrors.has(info.id)) {
        row.append(element('span', `请求未完成：${aiErrors.get(info.id)}`));
      }
      questionList.append(row);
    }
  }

  function mediaNodes() {
    return [...document.querySelectorAll('video, audio')].filter(node =>
      node.isConnected && (node.currentSrc || node.getAttribute('src') || node.querySelector('source[src]')) &&
      getComputedStyle(node).display !== 'none');
  }

  function playMedia(media, automatic = false) {
    if (!media) { message('当前页面没有视频或音频。'); return; }
    media.muted = automatic || !!preferences.mute;
    return media.play()
      .then(() => {
        renderMedia();
        if (!media.paused) message(`正在播放${media.tagName === 'VIDEO' ? '视频' : '音频'}。`);
      })
      .catch(error => {
        renderMedia();
        const kind = media.tagName === 'VIDEO' ? '视频' : '音频';
        message(error?.name === 'NotAllowedError'
          ? `浏览器未允许播放${kind}，请点原播放器的播放键。`
          : `${kind}未能播放：播放器或媒体资源可能尚未就绪。`);
        if (automatic) stopFlow('自动播放受阻，连续学习已停止；请点原播放器的播放键。');
      });
  }

  function startFlowMedia() {
    if (!isFlowOn() || !isMediaModule()) return;
    announceFlow('media-request');
    clearTimeout(mediaPermissionTimer);
    mediaPermissionTimer = setTimeout(startFlowMedia, 2500);
  }

  function playFlowMedia() {
    clearTimeout(mediaPermissionTimer);
    if (!isFlowOn() || !isMediaModule()) return;
    const all = mediaNodes();
    if (!all.length) return;
    const current = all.find(media => !media.ended);
    if (!current) {
      if (!flowEndAnnounced) {
        flowEndAnnounced = true;
        announceFlow('video-ended');
      }
      return;
    }
    if (flowMediaAttempted.has(current)) return;
    flowMediaAttempted.add(current);
    if (current.paused) playMedia(current, true);
  }

  function onMediaEnded(event) {
    const all = mediaNodes();
    const next = all[all.indexOf(event.currentTarget) + 1];
    if (next && (preferences.autoNextMedia || isFlowOn())) {
      if (isFlowOn()) flowMediaAttempted.add(next);
      playMedia(next, isFlowOn());
    } else {
      message('当前页面的媒体已播完。');
      if (isFlowOn() && isMediaModule() && !flowEndAnnounced) {
        flowEndAnnounced = true;
        announceFlow('video-ended');
      }
    }
  }

  function bindMedia() {
    for (const media of mediaNodes()) {
      if (media.dataset.cxLocalHelperBound) continue;
      media.dataset.cxLocalHelperBound = '1';
      media.addEventListener('ended', onMediaEnded);
      media.addEventListener('play', renderMedia);
      media.addEventListener('pause', () => {
        renderMedia();
        if (!media.ended) message('播放已暂停。学习通可能在切出页面时主动暂停，请保持学习页在前台。');
      });
      if (preferences.mute) media.muted = true;
    }
  }

  function renderMedia() {
    if (!mediaList) return;
    mediaList.replaceChildren();
    const all = mediaNodes();
    if (!all.length) return;
    for (const [index, media] of all.entries()) {
      const row = element('div', undefined, 'row');
      row.append(
        element('span', `${index + 1}. ${media.tagName === 'VIDEO' ? '视频' : '音频'}`),
        button(media.paused ? '播放' : '暂停', () => {
          if (media.paused) playMedia(media);
          else { media.pause(); message('已暂停。'); }
        })
      );
      mediaList.append(row);
    }
  }

  function enablePanelDrag(header) {
    const key = `${location.pathname}|${panelKinds}`;
    const clamp = (value, limit) => Math.max(0, Math.min(value, Math.max(0, limit)));
    const moveTo = (left, top) => {
      const rect = panel.getBoundingClientRect();
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = `${clamp(left, innerWidth - rect.width)}px`;
      panel.style.top = `${clamp(top, innerHeight - rect.height)}px`;
    };
    const saved = positions[key];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const rect = panel.getBoundingClientRect();
      moveTo(saved.x * (innerWidth - rect.width), saved.y * (innerHeight - rect.height));
    }
    let drag;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        left: rect.left, top: rect.top };
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    header.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      moveTo(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    });
    header.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = undefined;
      const rect = panel.getBoundingClientRect();
      positions[key] = {
        x: rect.left / Math.max(1, innerWidth - rect.width),
        y: rect.top / Math.max(1, innerHeight - rect.height)
      };
      writeStore(POSITION, positions);
    });
    header.addEventListener('pointercancel', () => { drag = undefined; });
  }

  function exportBank() {
    const blob = new Blob([JSON.stringify({ version: 1, answers: bank }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = 'chaoxing-local-answers.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('答案表已导出到本机。');
  }

  function importBank(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { message('文件超过 2 MB，未导入。'); return; }
    file.text().then(text => {
      const parsed = JSON.parse(text);
      if (parsed.version !== 1 || !parsed.answers || typeof parsed.answers !== 'object' || Array.isArray(parsed.answers)) {
        throw new Error('格式错误');
      }
      const next = { ...bank };
      let count = 0;
      for (const [id, entry] of Object.entries(parsed.answers)) {
        if (!/^\d+$/.test(id) || !entry || typeof entry !== 'object') continue;
        const answer = answerLetters(entry.answer);
        if (!answer) continue;
        next[id] = { answer, type: entry.type === 'multi' ? 'multi' : 'single' };
        count++;
      }
      bank = next;
      writeStore(STORE, bank);
      renderQuestions();
      message(`已从本机文件导入 ${count} 条答案。`);
    }).catch(() => message('导入失败：请检查 JSON 格式。'));
  }

  function createPanel() {
    const host = element('div');
    host.id = 'cx-local-helper';
    document.body.append(host);
    panelHost = host;
    panelKinds = `${mediaNodes().length > 0}:${questionNodes().length > 0}`;
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = element('style');
    style.textContent = `
      :host { all: initial; }
      .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        width: min(340px, calc(100vw - 32px)); max-height: min(65vh, 500px);
        overflow: auto; box-sizing: border-box; padding: 12px; border: 1px solid #475569;
        border-radius: 10px; background: #0f172a; color: #f8fafc;
        box-shadow: 0 8px 28px #0006; font: 13px/1.5 system-ui, sans-serif; }
      .panel.collapsed > :not(header) { display: none; }
      header, .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      header { justify-content: space-between; font-weight: 700; cursor: move;
        user-select: none; touch-action: none; }
      section { border-top: 1px solid #475569; margin-top: 9px; padding-top: 9px; }
      .row { margin: 5px 0; }
      .row span { flex: 1 1 110px; }
      button, input { font: inherit; border-radius: 5px; }
      button { cursor: pointer; padding: 3px 7px; border: 1px solid #64748b;
        color: #f8fafc; background: #334155; }
      button:hover { background: #475569; }
      input[type=text] { width: 64px; padding: 3px 5px; color: #0f172a; background: white; }
      input[type=file] { max-width: 220px; }
      img.preview { width: 100%; max-height: 320px; object-fit: contain; background: white; }
      label { display: block; margin: 5px 0; }
      .hint, .status { color: #cbd5e1; font-size: 12px; }
      .status { min-height: 18px; margin-top: 6px; }
    `;
    panel = element('div', undefined, 'panel');
    const header = element('header');
    header.title = '按住标题栏拖动位置';
    header.append(element('span', '学习通本地助手'), button('收起', event => {
      panel.classList.toggle('collapsed');
      event.currentTarget.textContent = panel.classList.contains('collapsed') ? '展开' : '收起';
    }));
    panel.append(header);

    if (mediaNodes().length) {
      const mediaSection = element('section');
      mediaSection.append(element('strong', '媒体控制'));
      mediaList = element('div');
      mediaSection.append(mediaList);
      const mute = element('input');
      mute.type = 'checkbox';
      mute.checked = preferences.mute;
      mute.addEventListener('change', () => {
        preferences.mute = mute.checked;
        writeStore(OPTIONS, preferences);
        mediaNodes().forEach(media => { media.muted = mute.checked; });
      });
      const muteLabel = element('label', ' 播放时静音');
      muteLabel.prepend(mute);
      mediaSection.append(muteLabel);
      const auto = element('input');
      auto.type = 'checkbox';
      auto.checked = preferences.autoNextMedia;
      auto.addEventListener('change', () => {
        preferences.autoNextMedia = auto.checked;
        writeStore(OPTIONS, preferences);
      });
      const autoLabel = element('label', ' 同页下一段媒体接续播放');
      autoLabel.prepend(auto);
      mediaSection.append(autoLabel);
      const popup = element('input');
      popup.type = 'checkbox';
      popup.checked = preferences.autoPopupQuestions;
      popup.addEventListener('change', () => {
        preferences.autoPopupQuestions = popup.checked;
        writeStore(OPTIONS, preferences);
      });
      const popupLabel = element('label', ' 播放中弹题自动询问、作答并继续');
      popupLabel.prepend(popup);
      mediaSection.append(popupLabel);
      panel.append(mediaSection);
      renderMedia();
    }

    if (questionNodes().length) {
      registerAIMenu();
      const quizSection = element('section');
      quizSection.append(element('strong', '本地答案表'));
      quizSection.append(element('div', '只按题目 ID 匹配；不会自动提交。', 'hint'));
      quizSection.append(element('div', '自动询问会逐题发送题图到 DeepSeek；自动填选开启时会选择答案，普通模式不会提交。', 'hint'));
      quizSection.append(button('设置 DeepSeek Key', setKeyFromPrompt));
      const autoAsk = element('input');
      autoAsk.type = 'checkbox';
      autoAsk.checked = preferences.autoAskQuestions;
      autoAsk.addEventListener('change', () => {
        preferences.autoAskQuestions = autoAsk.checked;
        writeStore(OPTIONS, preferences);
        if (autoAsk.checked) queueAutomaticQuestions();
        else {
          autoQueue.length = 0;
          message('已关闭后续自动询问；正在进行的请求会完成。');
        }
      });
      const autoAskLabel = element('label', ' 自动询问本页全部题目');
      autoAskLabel.prepend(autoAsk);
      quizSection.append(autoAskLabel);
      const autoFill = element('input');
      autoFill.type = 'checkbox';
      autoFill.checked = preferences.autoFillSuggestions;
      autoFill.addEventListener('change', () => {
        preferences.autoFillSuggestions = autoFill.checked;
        writeStore(OPTIONS, preferences);
        if (autoFill.checked) {
          fillCachedSuggestions();
          renderQuestions();
        }
      });
      const autoFillLabel = element('label', ' 收到 AI 建议后自动填选（不自动提交）');
      autoFillLabel.prepend(autoFill);
      quizSection.append(autoFillLabel);
      questionList = element('div');
      quizSection.append(questionList);
      const actions = element('div', undefined, 'row');
      actions.append(button('填入已保存答案', fillSavedAnswers), button('导出答案表', exportBank));
      quizSection.append(actions);
      const file = element('input');
      file.type = 'file';
      file.accept = '.json,application/json';
      file.addEventListener('change', () => importBank(file.files?.[0]));
      quizSection.append(file);
      panel.append(quizSection);
      renderQuestions();
    }
    const flowSection = element('section');
    flowButton = button(isFlowOn() ? '停止连续学习' : '开始连续学习', () => {
      if (isFlowOn()) stopFlow('连续学习已手动停止。');
      else startFlow();
    });
    mediaFirstButton = button(isFlowOn() ? '停止连续学习' : '先看完媒体再做测验', () => {
      if (isFlowOn()) stopFlow('连续学习已手动停止。');
      else startFlow('media-first');
    });
    flowSection.append(flowButton, mediaFirstButton,
      element('div', '按节模式：每节媒体结束后做测验。先媒体模式：本课程媒体全部完成后，再逐节做未完成测验。两种模式都会自动提交；遇到无法确认的状态会停止。', 'hint'));
    panel.append(flowSection);
    status = element('div', '答案表和 AI 建议保存在本机；自动询问开启时会发送每道新题。', 'status');
    panel.append(status);
    shadow.append(style, panel);
    enablePanelDrag(header);
  }

  function refresh() {
    const signature = `${mediaNodes().length}:${questionNodes().map(node => node.id).join(',')}`;
    if (!signature || signature === '0:' || signature === lastSignature) return;
    lastSignature = signature;
    bindMedia();
    const kinds = `${mediaNodes().length > 0}:${questionNodes().length > 0}`;
    if (!panel || panelKinds !== kinds) {
      panelHost?.remove();
      panel = undefined;
      questionList = undefined;
      mediaList = undefined;
      createPanel();
    }
    else { renderMedia(); renderQuestions(); }
    fillCachedSuggestions();
    renderQuestions();
    queueAutomaticQuestions();
    startFlowMedia();
    scheduleFlowQuiz();
  }

  function initTopFlow() {
    let badge;
    let badgeText;
    let quizTimer;
    let busy = false;
    let mediaProbeBusy = false;

    function showFlow(text) {
      if (!badge) {
        badge = element('div');
        badge.id = 'cx-local-flow-status';
        badge.style.cssText = 'position:fixed;top:52px;right:16px;z-index:2147483647;' +
          'max-width:300px;padding:9px 12px;border-radius:9px;background:#0f172a;' +
          'color:white;box-shadow:0 4px 16px #0005;font:13px/1.5 sans-serif;';
        badgeText = element('span');
        const stop = button('停止', () => {
          sessionStorage.removeItem(FLOW_KEY);
          clearTimeout(quizTimer);
          showFlow('连续学习已手动停止。');
        });
        stop.style.cssText = 'margin-left:8px;cursor:pointer;';
        badge.append(badgeText, stop);
        document.body.append(badge);
      }
      badgeText.textContent = text;
    }

    function isCurrentCardSource(source) {
      const card = document.querySelector('#iframe')?.contentWindow;
      let current = source;
      for (let depth = 0; depth < 5 && current; depth++) {
        if (current === card) return true;
        if (current === window) break;
        try { current = current.parent; } catch { break; }
      }
      return false;
    }

    function probeCardStatus() {
      const card = document.querySelector('#iframe')?.contentWindow;
      if (!card) return Promise.resolve(null);
      const requestId = `${Date.now()}:${Math.random()}`;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', onReply);
          resolve(null);
        }, 1500);
        function onReply(event) {
          if (event.origin !== location.origin || event.source !== card ||
            event.data?.source !== 'cx-local-helper-flow' ||
            event.data?.type !== 'card-status' || event.data.requestId !== requestId) return;
          clearTimeout(timer);
          window.removeEventListener('message', onReply);
          resolve({ finished: event.data.finished === true, ready: event.data.ready === true,
            num: event.data.num, knowledgeid: event.data.knowledgeid });
        }
        window.addEventListener('message', onReply);
        card.postMessage({ source: 'cx-local-helper-flow', type: 'probe-job', requestId }, location.origin);
      });
    }

    async function waitForCardFinished(expectedNum, timeout = 90000) {
      const started = Date.now();
      const expectedId = currentChapterId();
      while (isFlowOn() && Date.now() - started < timeout) {
        const card = await probeCardStatus();
        if (card?.num === expectedNum && card.knowledgeid === expectedId && card.finished) return true;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return false;
    }

    async function waitForCardNum(expectedNum, timeout = 12000, expectedId = currentChapterId()) {
      const started = Date.now();
      while (isFlowOn() && Date.now() - started < timeout) {
        const card = await probeCardStatus();
        if (card?.num === expectedNum && card.knowledgeid === expectedId) return true;
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      return false;
    }

    function halt(reason) {
      sessionStorage.removeItem(FLOW_KEY);
      clearTimeout(quizTimer);
      showFlow(reason);
    }

    function currentChapterId() {
      const cardSrc = document.querySelector('#iframe')?.getAttribute('src');
      const fromCard = cardSrc ? new URL(cardSrc, location.href).searchParams.get('knowledgeid') : '';
      return fromCard || new URLSearchParams(location.search).get('chapterId') || '';
    }

    function chapters() {
      return [...document.querySelectorAll('[id^="cur"]')]
        .filter(node => /^cur\d+$/.test(node.id))
        .map(node => ({ id: node.id.slice(3), node,
          done: !!node.querySelector('.icon_Completed') }));
    }

    async function showCard(num, expectedId = currentChapterId()) {
      const current = await probeCardStatus();
      if (current?.num === num && current.knowledgeid === expectedId) return true;
      const card = document.querySelector(num === '0' ? '#dct1' : '#dct2');
      if (!card) return false;
      card.click();
      if (await waitForCardNum(num, 15000, expectedId)) return true;
      card.click();
      return waitForCardNum(num, 15000, expectedId);
    }

    async function waitForReadyCard(num, id, timeout = 30000) {
      const started = Date.now();
      while (isFlowOn() && Date.now() - started < timeout) {
        const card = await probeCardStatus();
        if (card?.num === num && card.knowledgeid === id && card.ready) return card;
        await delay(800);
      }
      return null;
    }

    async function goToChapter(id, num) {
      if (!isFlowOn()) return false;
      updateFlow({ targetChapterId: id });
      if (currentChapterId() !== id) {
        if (!document.querySelector(`#cur${id} .posCatalog_name`)) {
          halt('目录中找不到下一节，连续学习已停止。'); return false;
        }
        for (let attempt = 0; attempt < 2 && currentChapterId() !== id; attempt++) {
          document.querySelector(`#cur${id} .posCatalog_name`)?.click();
          const started = Date.now();
          while (isFlowOn() && currentChapterId() !== id && Date.now() - started < 12000) {
            await delay(500);
          }
        }
        if (currentChapterId() !== id) {
          halt('章节跳转后页面未变化，连续学习已停止。');
          return false;
        }
      }
      updateFlow({ targetChapterId: null });
      if (!await showCard(num, id)) {
        halt(num === '0' ? '无法进入视频卡片，连续学习已停止。' : '无法进入测验卡片，连续学习已停止。');
        return false;
      }
      return true;
    }

    async function resumeMediaFirst() {
      if (busy || !isFlowOn()) return;
      const flow = flowState();
      if (flow?.mode !== 'media-first') return;
      busy = true;
      try {
        const items = chapters();
        if (!items.length) { halt('未找到课程目录，连续学习已停止。'); return; }
        const phase = flow.phase;
        const firstPending = items.find(item => !item.done);
        if (!firstPending) { halt('本课程任务点已全部完成。'); return; }
        const id = flow.targetChapterId ||
          (phase === 'media' && flow.mediaInitialized ? currentChapterId() : firstPending.id);
        if (phase === 'media') {
          updateFlow({ mediaInitialized: true });
          showFlow('先看完本课程媒体；正在检查当前节的视频任务点…');
        } else {
          showFlow('媒体阶段已结束；正在处理未完成的章节测验…');
        }
        if (!await goToChapter(id, phase === 'media' ? '0' : '1')) return;
        const card = await waitForReadyCard(phase === 'media' ? '0' : '1', id);
        if (!card) {
          halt('当前任务点长时间未加载，连续学习已停止。');
          return;
        }
        if (phase === 'media' && card?.finished) {
          busy = false;
          moveToQuiz();
          return;
        }
        if (phase === 'quiz' && card?.finished) {
          busy = false;
          moveToNext();
          return;
        }
        if (phase === 'quiz') {
          quizTimer = setTimeout(() => {
            if (isFlowOn()) halt('测验题目长时间未加载，连续学习已停止。');
          }, 90000);
        }
      } finally { busy = false; }
    }

    async function moveToQuiz() {
      if (busy || !isFlowOn()) return;
      busy = true;
      showFlow('视频结束，等待平台确认任务点完成…');
      if (!await waitForCardFinished('0')) {
        halt('视频任务点未确认完成，连续学习已停止。');
        busy = false;
        return;
      }
      if (mediaFirstPhase()) {
        const items = chapters();
        const current = items.findIndex(item => item.id === currentChapterId());
        const next = items.slice(current + 1).find(item => !item.done);
        if (next) {
          showFlow('本节媒体已完成，正在进入下一节媒体…');
          busy = false;
          if (await goToChapter(next.id, '0')) await resumeMediaFirst();
          return;
        }
        const firstPending = items.find(item => !item.done);
        if (!firstPending) { halt('本课程任务点已全部完成。'); busy = false; return; }
        updateFlow({ phase: 'quiz', targetChapterId: firstPending.id });
        showFlow('全部媒体已检查完成，开始逐节处理测验…');
        busy = false;
        await resumeMediaFirst();
        return;
      }
      showFlow('正在切换到章节测验…');
      if (!await showCard('1')) {
        halt('未能进入章节测验，连续学习已停止。');
        busy = false;
        return;
      }
      showFlow('已进入章节测验，等待题目加载…');
      quizTimer = setTimeout(() => {
        if (isFlowOn()) halt('测验题目长时间未加载，连续学习已停止。');
      }, 90000);
      busy = false;
    }

    async function moveToNext() {
      if (busy || !isFlowOn()) return;
      busy = true;
      clearTimeout(quizTimer);
      const confirmStarted = Date.now();
      while (isFlowOn() && Date.now() - confirmStarted < 15000) {
        const prompt = document.querySelector('#popcontent');
        const okay = document.querySelector('#popok');
        if (prompt && okay && /提交|确认|确定/.test(prompt.textContent || '') &&
          okay.getBoundingClientRect().width > 0) {
          showFlow('确认提交章节测验…');
          okay.click();
          break;
        }
        if ((await probeCardStatus())?.finished) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      showFlow('测验已提交，等待平台确认任务点完成…');
      let confirmed = await waitForCardFinished('1', 30000);
      for (let attempt = 0; !confirmed && attempt < 2 && isFlowOn(); attempt++) {
        const quiz = document.querySelector('#dct2');
        if (!quiz) break;
        showFlow('正在刷新测验任务点状态…');
        quiz.click();
        confirmed = await waitForCardFinished('1', 30000);
      }
      if (!confirmed) {
        halt('测验提交后未确认完成，连续学习已停止，请检查页面。');
        busy = false;
        return;
      }
      const items = chapters();
      const current = items.findIndex(item => item.id === currentChapterId());
      const next = items.slice(current + 1).find(item =>
        flowState()?.mode !== 'media-first' || !item.done);
      if (!next) {
        halt('已到课程末尾，连续学习已完成。');
        busy = false;
        return;
      }
      showFlow('本节完成，正在进入下一节并核对跳转…');
      busy = false;
      await goToChapter(next.id, flowState()?.mode === 'media-first' ? '1' : '0');
      if (flowState()?.mode === 'media-first') resumeMediaFirst();
    }

    window.addEventListener('message', event => {
      if (event.origin !== location.origin || !isCurrentCardSource(event.source) ||
        event.data?.source !== 'cx-local-helper-flow') return;
      const { type, detail } = event.data;
      if (type === 'started') {
        showFlow('连续学习已启动，等待当前任务点完成…');
        if (flowState()?.mode === 'media-first') {
          resumeMediaFirst();
        } else if (document.querySelector('#dct1.active')) {
          probeCardStatus().then(card => {
            if (card?.num === '0' && card.finished && isFlowOn()) moveToQuiz();
          });
        }
      }
      else if (type === 'stopped') halt(detail || '连续学习已停止。');
      else if (isFlowOn() && flowState()?.phase !== 'quiz' &&
        type === 'media-request' && !mediaProbeBusy) {
        mediaProbeBusy = true;
        probeCardStatus().then(card => {
          mediaProbeBusy = false;
          if (!isFlowOn() || card?.num !== '0' || !card.ready) return;
          if (card.finished) moveToQuiz();
          else event.source.postMessage({ source: 'cx-local-helper-flow', type: 'start-media' }, location.origin);
        });
      }
      else if (isFlowOn() && flowState()?.phase !== 'quiz' && type === 'video-ended') moveToQuiz();
      else if (isFlowOn() && type === 'quiz-ready') {
        clearTimeout(quizTimer);
        showFlow('题目已加载，等待 AI 建议并填选…');
      }
      else if (isFlowOn() && type === 'quiz-submitted') moveToNext();
    });

    if (isFlowOn()) {
      showFlow('连续学习运行中，等待当前任务点加载…');
      if (flowState()?.mode === 'media-first') setTimeout(resumeMediaFirst, 0);
    }
  }

  function initPlaybackQuiz() {
    const processed = new Set();
    const retryAt = new Map();
    const retryFailures = new Map();
    let busy = false;
    let lastProblem = '';

    function visible(node) {
      if (!node?.isConnected) return false;
      const rect = node.getBoundingClientRect();
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
        style.display !== 'none' && style.opacity !== '0';
    }

    function frameDocuments(root, depth = 0) {
      if (depth > 4) return [];
      const result = [root];
      for (const frame of root.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument?.documentElement) {
            result.push(...frameDocuments(frame.contentDocument, depth + 1));
          }
        } catch { /* Cross-origin frames cannot expose their questions. */ }
      }
      return result;
    }

    function currentMedia(docs) {
      for (const doc of docs) {
        const media = [...doc.querySelectorAll('video, audio')].find(node =>
          node.currentTime > 1 && !node.ended && !!(node.currentSrc || node.src));
        if (media) return media;
      }
      return null;
    }

    function optionInfo(root) {
      const options = [];
      const seen = new Set();
      const nodes = root.querySelectorAll('li, label, [role="radio"], [role="checkbox"]');
      for (const node of nodes) {
        if (!visible(node)) continue;
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        const match = /^([A-H])(?:[.、．:：)）\s]|$)(.*)$/i.exec(text);
        if (!match || seen.has(match[1].toUpperCase())) continue;
        if (!match[2].trim() || match[2].length > 400) continue;
        seen.add(match[1].toUpperCase());
        options.push({ letter: match[1].toUpperCase(), text: match[2].trim(), node });
      }
      return options;
    }

    function findPlaybackQuestion(docs, media) {
      if (!media?.paused) return null;
      for (const doc of docs) {
        const selectors = '#topicList, .ans-videoquiz, .ans-topic, .topic-item, ' +
          '.el-dialog .TiMu, .popContent .TiMu, .maskDiv .TiMu, ' +
          '.vjs-overlay .TiMu, .vjs-modal-dialog .TiMu';
        for (const root of doc.querySelectorAll(selectors)) {
          if (!visible(root) || !root.innerText?.trim()) continue;
          // The chapter work card is not a playback interruption.
          if (root.closest('.singleQuesId, .questionLi')) continue;
          const options = optionInfo(root);
          if (options.length < 2 || options.length > 8) continue;
          const copy = root.cloneNode(true);
          copy.querySelectorAll('li, label, [role="radio"], [role="checkbox"], button, a, input')
            .forEach(node => node.remove());
          let title = (copy.innerText || copy.textContent || '').replace(/\s+/g, ' ').trim();
          if (!title) {
            const full = root.innerText.replace(/\s+/g, ' ').trim();
            title = full.split(/\bA[.、．:：)）\s]/)[0].trim();
          }
          if (title.length < 5 || title.length > 1200) continue;
          const kind = /多选/.test(title) || options.some(option =>
            option.node.querySelector('input[type="checkbox"], [role="checkbox"]')) ? 'multi' : 'single';
          return { root, title, options, kind, media,
            signature: `${title}|${options.map(option => `${option.letter}:${option.text}`).join('|')}` };
        }
      }
      return null;
    }

    function showPopup(text) {
      if (!popupBadge) {
        popupBadge = element('div');
        popupBadge.id = 'cx-local-popup-status';
        popupBadge.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;' +
          'max-width:360px;padding:10px 12px;border-radius:9px;background:#0f172a;' +
          'color:white;box-shadow:0 4px 16px #0005;font:13px/1.5 sans-serif;';
        document.body.append(popupBadge);
      }
      popupBadge.textContent = text;
    }

    async function askPopup(question, key) {
      const payload = {
        model: 'deepseek-flash',
        messages: [
          { role: 'system', content: '解答给定的中文选择题，按题干实际措辞判断，不要将事实判断改写成道德要求。只输出 JSON 对象：{"answer":"A","reason":"简短理由"}。多选题可输出多个字母。若信息不足，answer 设为空字符串。不要猜测。' },
          { role: 'user', content: `${question.kind === 'multi' ? '多选题' : '单选或判断题'}\n${question.title}\n${question.options.map(option => `${option.letter}. ${option.text}`).join('\n')}` }
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: 'none',
        temperature: 0,
        max_tokens: 300
      };
      const responseText = await requestDeepSeek(payload, key, progress =>
        showPopup(`播放中弹题：${progress}`));
      try {
        const content = JSON.parse(responseText).choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        const answer = answerLetters(parsed.answer);
        if (!answer || (question.kind !== 'multi' && answer.length !== 1) ||
          [...answer].some(letter => !question.options.some(option => option.letter === letter))) {
          throw new Error('模型未给出有效选项');
        }
        return answer;
      } catch { throw new Error('模型回复无法识别'); }
    }

    function submitPopup(question, answer) {
      for (const letter of answer) {
        const option = question.options.find(item => item.letter === letter);
        if (!option || !visible(option.node)) return false;
        const input = option.node.querySelector('input[type="radio"], input[type="checkbox"]');
        if (input) {
          if (!input.checked) input.click();
          if (!input.checked) option.node.querySelector('label')?.click();
          if (!input.checked) return false;
        } else {
          const label = option.node.querySelector('label');
          if (label) label.click();
          else option.node.click();
        }
      }
      const ownDoc = question.root.ownerDocument;
      const controls = [...question.root.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')];
      const nearby = question.root.parentElement?.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]') || [];
      controls.push(...nearby);
      const action = controls.find(node => visible(node) &&
        /^(提交|确定|确认|完成|继续学习|继续播放|继续)$/.test(
          (node.innerText || node.value || node.textContent || '').trim()));
      if (action) action.click();
      else {
        // Some player quizzes accept an option immediately and then show Continue.
        const again = [...ownDoc.querySelectorAll('button, a, [role="button"]')].find(node =>
          visible(node) && /^(继续学习|继续播放)$/.test((node.innerText || node.textContent || '').trim()));
        if (again) again.click();
      }
      return true;
    }

    async function tick() {
      if (busy || !preferences.autoPopupQuestions) return;
      const key = GM_getValue(API_KEY, '');
      if (!key) return;
      const docs = frameDocuments(document);
      const media = currentMedia(docs);
      const question = findPlaybackQuestion(docs, media);
      if (!question || processed.has(question.signature) ||
        Date.now() < (retryAt.get(question.signature) || 0)) return;
      busy = true;
      popupBusy = true;
      popupLastSignature = question.signature;
      showPopup('检测到播放中弹题，正在请求 DeepSeek…');
      try {
        const answer = await askPopup(question, key);
        if (!question.root.isConnected || !visible(question.root)) throw new Error('弹题已关闭');
        if (!submitPopup(question, answer)) throw new Error('未能选择答案');
        showPopup(`播放中弹题已选 ${answer}，正在核对是否继续播放。`);
        const submittedAt = Date.now();
        const clickedContinue = new WeakSet();
        while (visible(question.root) && question.media.paused && Date.now() - submittedAt < 15000) {
          const controls = [...(question.root.parentElement || question.root).querySelectorAll(
            'button, a, input[type="button"], [role="button"]')];
          const next = controls.find(node => visible(node) && !clickedContinue.has(node) &&
            /^(继续|继续学习|继续播放|下一题|完成)$/.test(
              (node.innerText || node.value || node.textContent || '').trim()));
          if (next) { clickedContinue.add(next); next.click(); }
          await delay(500);
        }
        if (visible(question.root) && question.media.paused) {
          throw new Error('题目仍在屏幕上，可能需要人工核对答案或提交');
        }
        processed.add(question.signature);
        retryAt.delete(question.signature);
        retryFailures.delete(question.signature);
        if (question.media.paused && !question.media.ended) {
          try { await question.media.play(); }
          catch { throw new Error('已作答，但浏览器阻止恢复播放'); }
        }
        showPopup(`播放中弹题已处理，播放器${question.media.paused ? '待启动' : '正在播放'}。`);
      } catch (error) {
        lastProblem = error.message;
        popupLastFailure = `${question.signature}:${lastProblem}`;
        if (error.retryable) {
          const failures = (retryFailures.get(question.signature) || 0) + 1;
          retryFailures.set(question.signature, failures);
          if (failures < 3) {
            retryAt.set(question.signature, Date.now() + 5 * 60 * 1000);
            showPopup(`播放中弹题请求暂时失败：${lastProblem}；5 分钟后自动重试。`);
          } else {
            processed.add(question.signature);
            showPopup(`播放中弹题连续请求失败：${lastProblem}。`);
            if (isFlowOn()) stopFlow(`播放中弹题连续请求失败：${lastProblem}。`);
          }
        } else {
          processed.add(question.signature);
          showPopup(`播放中弹题未自动完成：${lastProblem}。`);
          if (isFlowOn()) stopFlow(`播放中弹题未完成：${lastProblem}。`);
        }
      } finally {
        busy = false;
        popupBusy = false;
      }
    }

    showPopup(!preferences.autoPopupQuestions ? '播放中弹题监测已关闭。' :
      GM_getValue(API_KEY, '') ? '播放中弹题监测已开启。' : '播放中弹题监测缺少 DeepSeek Key。');
    setInterval(tick, 1000);
    tick();
  }

  function initCardFlowProbe() {
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== window.parent ||
        event.data?.source !== 'cx-local-helper-flow' || event.data?.type !== 'probe-job') return;
      const icons = [...document.querySelectorAll('.ans-job-icon')];
      const finished = icons.length > 0 && icons.every(icon =>
        icon.classList.contains('ans-job-finished') ||
        /已完成/.test(icon.getAttribute('aria-label') || ''));
      window.parent.postMessage({ source: 'cx-local-helper-flow', type: 'card-status',
        requestId: event.data.requestId, finished, ready: icons.length > 0,
        num: new URLSearchParams(location.search).get('num'),
        knowledgeid: new URLSearchParams(location.search).get('knowledgeid') }, location.origin);
    });
  }

  if (isMediaModule()) {
    window.addEventListener('message', event => {
      if (event.origin === location.origin && event.source === window.top &&
        event.data?.source === 'cx-local-helper-flow' && event.data?.type === 'start-media') {
        playFlowMedia();
      }
    });
  }

  if (window === window.top && location.pathname === '/mycourse/studentstudy') {
    initTopFlow();
    initPlaybackQuiz();
  } else {
    if (location.pathname.startsWith('/mooc-ans/knowledge/cards')) initCardFlowProbe();
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(refresh, 2000);
    window.addEventListener('storage', event => {
      if (event.key === FLOW_KEY && flowButton) {
        flowButton.textContent = isFlowOn() ? '停止连续学习' : '开始连续学习';
        if (mediaFirstButton) mediaFirstButton.textContent = isFlowOn() ? '停止连续学习' : '先看完媒体再做测验';
      }
    });
  }
})();
