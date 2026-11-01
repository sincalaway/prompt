(() => {
  'use strict';

  const EDITOR_API = 'https://paired-gallery-editor.sincalaway.workers.dev';
  const STORAGE_KEY = 'paired-gallery-editor-key';
  const originalRender = window.render;
  const originalShowDetail = window.showDetail;
  let state = null;

  if (typeof originalRender !== 'function' || typeof originalShowDetail !== 'function') return;

  const makeButton = (text, className, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  };

  function recordIndex(item) {
    if (!manifest || !shardCache) return -1;
    for (const shard of manifest.shards) {
      const records = shardCache.get(shard.id);
      if (!Array.isArray(records)) continue;
      const offset = records.indexOf(item);
      if (offset >= 0) return shard.start + offset;
    }
    return -1;
  }

  function resetState() {
    if (state?.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state = null;
  }

  function newState(item) {
    resetState();
    const index = recordIndex(item);
    state = {
      item,
      index,
      expected: JSON.parse(JSON.stringify(item)),
      imageAction: 'none',
      image: null,
      previewUrl: null,
      previewConfirmed: false,
    };
    return state;
  }

  function attachCardButtons() {
    const cards = [...document.querySelectorAll('#grid .card')];
    const items = filtered?.slice(0, visible) || [];
    cards.forEach((card, index) => {
      if (card.querySelector('.editor-card-submit')) return;
      const item = items[index];
      if (!item) return;
      const foot = card.querySelector('.card-foot');
      if (!foot) return;
      const submit = makeButton('提交 GitHub 并更新公开图库', 'editor-submit editor-card-submit', () => {
        window.showDetail(item);
      });
      submit.setAttribute('aria-label', `编辑并提交：${window.displayTitle?.(item) || item.category || '这条记录'}`);
      foot.append(submit);
    });
  }

  function setImageStatus(text) {
    const status = document.getElementById('detailImageStatus');
    if (status) status.textContent = text;
  }

  function restoreImagePreview() {
    if (!state) return;
    const modal = document.getElementById('modal');
    const pane = document.getElementById('detailImagePane');
    const image = document.getElementById('detailImage');
    const imageButton = document.getElementById('detailImageButton');
    const notice = document.getElementById('detailImageNotice');
    const hasImage = Boolean(state.item.image);
    modal.classList.toggle('no-image', !hasImage);
    pane.hidden = false;
    notice.hidden = hasImage;
    if (hasImage) {
      imageButton.hidden = false;
      pane.querySelector('.editor-image-empty')?.remove();
      window.loadPreviewImage(image, state.item, document.getElementById('detailImageStatus'));
      image.alt = window.displayTitle?.(state.item) || '图片';
    } else {
      imageButton.hidden = true;
      image.removeAttribute('src');
      ensureEmptyImageNote(pane);
      setImageStatus('');
    }
  }

  function ensureEmptyImageNote(pane) {
    if (pane.querySelector('.editor-image-empty')) return;
    const note = document.createElement('div');
    note.className = 'editor-image-empty';
    note.textContent = '此记录当前没有图片，可选择“替换图片”上传';
    pane.insertBefore(note, pane.querySelector('.image-tools'));
  }

  function mountEditor(item) {
    const current = newState(item);
    const modal = document.getElementById('modal');
    const detailCategory = document.getElementById('detailCategory');
    const themeButton = makeButton('编辑主题', 'editor-action', () => {
      const input = document.querySelector('.editor-category-input');
      input.hidden = !input.hidden;
      if (!input.hidden) input.focus();
    });
    const categoryInput = document.createElement('input');
    categoryInput.className = 'editor-category-input';
    categoryInput.type = 'text';
    categoryInput.maxLength = 100;
    categoryInput.value = item.category || '';
    categoryInput.placeholder = '输入主题';
    categoryInput.hidden = true;
    detailCategory.after(themeButton, categoryInput);

    const imagePane = document.getElementById('detailImagePane');
    const imageButton = document.getElementById('detailImageButton');
    const imageTools = document.querySelector('.image-tools');
    imagePane.hidden = false;
    imageButton.hidden = !item.image;
    imagePane.querySelector('.editor-image-empty')?.remove();
    if (!item.image) ensureEmptyImageNote(imagePane);
    imageTools.querySelectorAll('[data-editor-control]').forEach(node => node.remove());
    const replaceButton = makeButton('替换图片', 'editor-action', () => fileInput.click());
    replaceButton.dataset.editorControl = '1';
    const deleteButton = makeButton('删除图片', 'editor-action editor-danger', () => {
      if (!current.item.image) return;
      const title = window.displayTitle?.(current.item) || current.item.category || '未命名记录';
      const number = current.index >= 0 ? current.index + 1 : '未知';
      const approved = window.confirm(`确认删除第 ${number} 条记录的图片？\n${title}\n只移除图片文件的引用，保留提示词和记录。`);
      if (!approved) return;
      if (current.previewUrl) URL.revokeObjectURL(current.previewUrl);
      current.previewUrl = null;
      current.image = null;
      current.imageAction = 'delete';
      current.previewConfirmed = false;
      const previewLabel = imageTools.querySelector('.editor-preview-confirm');
      if (previewLabel) previewLabel.remove();
      restoreImagePreview();
      setImageStatus('待删除 · 点击“提交 GitHub 并更新公开图库”保存');
    });
    deleteButton.dataset.editorControl = '1';
    deleteButton.disabled = !item.image;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/png,image/webp';
    fileInput.hidden = true;
    fileInput.dataset.editorControl = '1';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        window.alert('请选择 JPG、PNG 或 WebP 图片。');
        fileInput.value = '';
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        window.alert('图片不能超过 8 MB。请先压缩后重试。');
        fileInput.value = '';
        return;
      }
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('图片读取失败'));
          reader.onload = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(file);
        });
        const previewUrl = URL.createObjectURL(file);
        const dimensions = await new Promise((resolve, reject) => {
          const preview = new Image();
          preview.onload = () => resolve({ width: preview.naturalWidth, height: preview.naturalHeight });
          preview.onerror = () => reject(new Error('图片预览失败'));
          preview.src = previewUrl;
        });
        if (current.previewUrl) URL.revokeObjectURL(current.previewUrl);
        current.previewUrl = previewUrl;
        current.imageAction = 'replace';
        current.previewConfirmed = false;
        current.image = {
          mime: file.type,
          data: dataUrl.slice(dataUrl.indexOf(',') + 1),
          width: dimensions.width,
          height: dimensions.height,
        };
        const modal = document.getElementById('modal');
        modal.classList.remove('no-image');
        imagePane.hidden = false;
        imageButton.hidden = false;
        imagePane.querySelector('.editor-image-empty')?.remove();
        document.getElementById('detailImageNotice').hidden = true;
        const img = document.getElementById('detailImage');
        img.src = previewUrl;
        img.alt = `替换图片预览：${window.displayTitle?.(item) || '当前记录'}`;
        setImageStatus(`替换预览 · ${dimensions.width} × ${dimensions.height} px`);
        let confirmLabel = imageTools.querySelector('.editor-preview-confirm');
        if (!confirmLabel) {
          confirmLabel = document.createElement('label');
          confirmLabel.className = 'editor-preview-confirm';
          confirmLabel.dataset.editorControl = '1';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.addEventListener('change', () => { current.previewConfirmed = checkbox.checked; });
          const text = document.createElement('span');
          text.textContent = '我已核对预览，确认替换此图片';
          confirmLabel.append(checkbox, text);
          imageTools.append(confirmLabel);
        } else {
          confirmLabel.querySelector('input').checked = false;
        }
      } catch (error) {
        window.alert(error.message || '图片预览失败，请换一张图片。');
        fileInput.value = '';
      }
    });
    imageTools.prepend(replaceButton, deleteButton, fileInput);

    document.querySelectorAll('#detailPrompts .prompt-block').forEach((block, index) => {
      const label = block.querySelector('.prompt-label');
      const text = block.querySelector('.prompt-text');
      const kind = index < (item.prompts || []).length ? 'prompts' : 'negativePrompts';
      const fieldIndex = kind === 'prompts' ? index : index - (item.prompts || []).length;
      const edit = makeButton('编辑提示词', 'editor-action editor-prompt-action', () => {
        let textarea = block.querySelector('.editor-prompt-input');
        if (!textarea) {
          textarea = document.createElement('textarea');
          textarea.className = 'editor-prompt-input';
          textarea.value = text.textContent || '';
          textarea.dataset.kind = kind;
          textarea.dataset.index = String(fieldIndex);
          text.after(textarea);
        }
        text.hidden = !text.hidden;
        textarea.hidden = !textarea.hidden;
        if (!textarea.hidden) textarea.focus();
      });
      label.append(edit);
    });

    const submit = makeButton('提交 GitHub 并更新公开图库', 'editor-submit editor-modal-submit', submitEdit);
    submit.dataset.editorControl = '1';
    const note = document.createElement('p');
    note.className = 'editor-note';
    note.dataset.editorControl = '1';
    note.textContent = current.index >= 0
      ? `记录 #${current.index + 1} · 修改仅作用于此条记录；提交前会再次确认。`
      : '无法安全定位此记录，请刷新后重试。';
    const panel = document.createElement('div');
    panel.className = 'editor-panel';
    panel.dataset.editorControl = '1';
    panel.append(note, submit);
    document.querySelector('.detail-content').append(panel);
  }

  function collectChanges() {
    const changes = {};
    const categoryInput = document.querySelector('.editor-category-input');
    const category = categoryInput?.value.trim();
    if (category && category !== String(state.expected.category || '').trim()) changes.category = category;
    const prompts = [...(state.item.prompts || [])].map(field => ({ label: field.label || '提示词(Prompt)', text: field.text || '' }));
    const negativePrompts = [...(state.item.negativePrompts || [])].map(field => ({ label: field.label || '负面提示词', text: field.text || '' }));
    let promptsChanged = false;
    let negativeChanged = false;
    document.querySelectorAll('.editor-prompt-input').forEach(textarea => {
      const kind = textarea.dataset.kind;
      const index = Number(textarea.dataset.index);
      const target = kind === 'prompts' ? prompts : negativePrompts;
      if (!Number.isInteger(index) || !target[index]) return;
      if (target[index].text !== textarea.value) {
        target[index].text = textarea.value;
        if (kind === 'prompts') promptsChanged = true;
        else negativeChanged = true;
      }
    });
    if (promptsChanged) changes.prompts = prompts;
    if (negativeChanged) changes.negativePrompts = negativePrompts;
    changes.imageAction = state.imageAction;
    if (state.imageAction === 'replace') changes.image = state.image;
    return changes;
  }

  async function submitEdit(event) {
    const button = event.currentTarget;
    if (!state || state.index < 0) {
      window.alert('无法安全定位这条记录，请刷新图库后重试。');
      return;
    }
    const changes = collectChanges();
    const hasChange = Object.keys(changes).some(key => key === 'category' || key === 'prompts' || key === 'negativePrompts' || (key === 'imageAction' && changes.imageAction !== 'none'));
    if (!hasChange) {
      window.alert('尚未修改主题、提示词或图片。');
      return;
    }
    if (changes.imageAction === 'replace' && !state.previewConfirmed) {
      window.alert('请先核对左侧替换图片预览，并勾选确认框。');
      return;
    }
    if (changes.category !== undefined && !changes.category) {
      window.alert('主题不能为空。');
      return;
    }
    const title = window.displayTitle?.(state.item) || state.item.category || '未命名记录';
    const summary = [
      `记录 #${state.index + 1}：${title}`,
      changes.category ? `新主题：${changes.category}` : '',
      changes.prompts ? '更新正向提示词' : '',
      changes.negativePrompts ? '更新负面提示词' : '',
      changes.imageAction === 'replace' ? '替换图片（已预览）' : '',
      changes.imageAction === 'delete' ? '删除此记录的图片（提示词保留）' : '',
      '',
      '确认提交到 GitHub main 并更新公开图库？',
    ].filter(Boolean).join('\n');
    if (!window.confirm(summary)) return;

    let key = sessionStorage.getItem(STORAGE_KEY) || '';
    if (!key) {
      key = window.prompt('请输入图库管理员编辑密钥。密钥只保存在当前标签页，不会写入公开页面。') || '';
      if (!key) return;
      sessionStorage.setItem(STORAGE_KEY, key);
    }
    button.disabled = true;
    button.textContent = '正在安全提交…';
    try {
      const response = await fetch(`${EDITOR_API}/api/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ recordIndex: state.index, expected: state.expected, changes }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        sessionStorage.removeItem(STORAGE_KEY);
        throw new Error('管理员密钥不正确，已清除本标签页中的密钥；请重新提交并输入正确密钥。');
      }
      if (!response.ok) throw new Error(result.error || `提交失败（HTTP ${response.status}）。`);

      if (changes.category !== undefined) {
        state.item.category = changes.category;
        state.item.categories = [changes.category];
      }
      if (changes.prompts) state.item.prompts = changes.prompts;
      if (changes.negativePrompts) state.item.negativePrompts = changes.negativePrompts;
      if (changes.imageAction === 'delete') {
        delete state.item.image;
        delete state.item.originalImage;
        delete state.item.imageWidth;
        delete state.item.imageHeight;
      } else if (changes.imageAction === 'replace') {
        state.item.image = result.imagePath;
        delete state.item.originalImage;
        state.item.imageWidth = changes.image.width;
        state.item.imageHeight = changes.image.height;
      }
      if (typeof window.render === 'function') window.render();
      window.showDetail(state.item);
      window.toast?.('GitHub 已提交，公开图库正在更新');
    } catch (error) {
      window.alert(error.message || '提交失败，请检查网络后重试。');
      button.disabled = false;
      button.textContent = '提交 GitHub 并更新公开图库';
    }
  }

  window.render = function (...args) {
    const result = originalRender.apply(this, args);
    attachCardButtons();
    return result;
  };
  window.showDetail = function (item, ...args) {
    const result = originalShowDetail.call(this, item, ...args);
    mountEditor(item);
    return result;
  };
  document.getElementById('modal')?.addEventListener('close', resetState);
})();
