const GITHUB_API = 'https://api.github.com';
const OWNER = 'sincalaway';
const REPO = 'prompt';
const BRANCH = 'main';
const GALLERY = 'paired-image-prompt-gallery';
const ALLOWED_ORIGIN = 'https://paired-image-prompt-gallery.pages.dev';
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, origin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Max-Age'] = '86400';
    headers.Vary = 'Origin';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function secureEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function github(path, env, method = 'GET', body = undefined) {
  const response = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'paired-image-prompt-gallery-editor',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* Keep errors generic. */ }
  if (!response.ok) {
    if (response.status === 404) throw new RequestError(409, '目标文件或分支不存在，未提交任何更改。');
    if (response.status === 409 || response.status === 422) throw new RequestError(409, 'GitHub 分支刚刚发生变化。请刷新图库后重试；本次更改未覆盖其他提交。');
    throw new RequestError(502, `GitHub 暂时无法完成提交（HTTP ${response.status}）。`);
  }
  return data;
}

function decodeBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new RequestError(400, '替换图片数据格式无效。');
  }
  let binary;
  try { binary = atob(text); } catch { throw new RequestError(400, '替换图片数据无法解码。'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageExtension(bytes, mime) {
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isWebp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (mime === 'image/jpeg' && isJpeg) return 'jpg';
  if (mime === 'image/png' && isPng) return 'png';
  if (mime === 'image/webp' && isWebp) return 'webp';
  throw new RequestError(400, '仅支持内容类型正确的 JPG、PNG 或 WebP 图片。');
}

function categoriesOf(record) {
  const values = Array.isArray(record.categories) ? record.categories : [record.category];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

async function readJsonFile(path, env) {
  const item = await github(`/contents/${encodePath(path)}?ref=${encodeURIComponent(BRANCH)}`, env);
  if (item.type !== 'file' || typeof item.sha !== 'string') {
    throw new RequestError(502, 'GitHub 返回的数据文件格式异常。');
  }
  let encoded = item.encoding === 'base64' && typeof item.content === 'string' ? item.content : '';
  if (!encoded.trim()) {
    const blob = await github(`/git/blobs/${encodeURIComponent(item.sha)}`, env);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new RequestError(502, 'GitHub 返回的大型数据分片格式异常。');
    encoded = blob.content;
  }
  const bytes = decodeBase64(encoded.replace(/\s/g, ''));
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new RequestError(502, '图库数据文件无法解析，未提交更改。'); }
}

function stableRecordEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function handleEdit(request, env) {
  if (!env.GITHUB_TOKEN || !env.ADMIN_TOKEN) throw new RequestError(503, '编辑服务未完成安全配置。');
  const auth = request.headers.get('Authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!secureEquals(supplied, env.ADMIN_TOKEN)) throw new RequestError(401, '管理员密钥不正确。');

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new RequestError(413, '提交内容过大，请将图片压缩到 8 MB 以内。');
  let payload;
  try { payload = await request.json(); }
  catch { throw new RequestError(400, '提交内容不是有效 JSON。'); }

  const index = Number(payload.recordIndex);
  if (!Number.isSafeInteger(index) || index < 0 || !payload.expected || typeof payload.expected !== 'object') {
    throw new RequestError(400, '记录定位信息无效。');
  }
  const changes = payload.changes || {};
  const hasTitle = Object.prototype.hasOwnProperty.call(changes, 'title');
  const hasCategory = Object.prototype.hasOwnProperty.call(changes, 'category');
  const hasAddCategory = Object.prototype.hasOwnProperty.call(changes, 'addCategory');
  const hasPrompts = Object.prototype.hasOwnProperty.call(changes, 'prompts');
  const hasNegativePrompts = Object.prototype.hasOwnProperty.call(changes, 'negativePrompts');
  const imageAction = changes.imageAction || 'none';
  if (!hasTitle && !hasCategory && !hasAddCategory && !hasPrompts && !hasNegativePrompts && imageAction === 'none') {
    throw new RequestError(400, '没有检测到需要提交的修改。');
  }
  if (!['none', 'delete', 'replace'].includes(imageAction)) throw new RequestError(400, '图片操作无效。');
  if (imageAction === 'replace' && !changes.image) throw new RequestError(400, '替换图片缺少预览文件。');
  if (imageAction !== 'replace' && changes.image) throw new RequestError(400, '图片文件与所选操作不匹配。');

  const manifestPath = `${GALLERY}/data/manifest.json`;
  const manifest = await readJsonFile(manifestPath, env);
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.shards)) throw new RequestError(502, '图库清单格式不兼容。');
  const shard = manifest.shards.find(entry => index >= entry.start && index < entry.start + entry.count);
  if (!shard) throw new RequestError(404, '这条记录已不存在，请刷新图库后重试。');

  const shardPath = `${GALLERY}/data/${shard.file}`;
  const records = await readJsonFile(shardPath, env);
  const localIndex = index - shard.start;
  const current = records[localIndex];
  if (!current || !stableRecordEquals(current, payload.expected)) {
    throw new RequestError(409, '这条记录自页面载入后已变化。请刷新图库后确认配对内容，再重新编辑。');
  }

  const record = JSON.parse(JSON.stringify(current));
  const oldCategories = categoriesOf(current);
  if (hasTitle) {
    const title = String(changes.title || '').trim();
    if (!title || title.length > 160) throw new RequestError(400, '标题必须填写，且不能超过 160 个字符。');
    record.title = title;
  }
  if (hasCategory) {
    const category = String(changes.category || '').trim();
    if (!category || category.length > 100) throw new RequestError(400, '主题必须填写，且不能超过 100 个字符。');
    record.category = category;
    record.categories = [category];
  }
  if (hasAddCategory) {
    const category = String(changes.addCategory || '').trim();
    if (!category || category.length > 100) throw new RequestError(400, '新增主题必须填写，且不能超过 100 个字符。');
    const existing = categoriesOf(record);
    if (existing.includes(category)) throw new RequestError(400, '这条记录已经包含该主题。');
    record.categories = [...existing, category];
  }
  for (const key of ['prompts', 'negativePrompts']) {
    const present = key === 'prompts' ? hasPrompts : hasNegativePrompts;
    if (!present) continue;
    const value = changes[key];
    if (!Array.isArray(value) || value.length > 30) throw new RequestError(400, '提示词字段格式无效。');
    if (key === 'prompts' && value.length === 0) throw new RequestError(400, '至少保留一条正向提示词。');
    record[key] = value.map(field => {
      const label = String(field?.label || '').trim().slice(0, 100);
      const text = String(field?.text || '');
      if (text.length > 100000) throw new RequestError(400, '单条提示词不能超过 100,000 个字符。');
      return { label: label || (key === 'prompts' ? '提示词(Prompt)' : '负面提示词'), text };
    });
  }

  let imageBlobSha = null;
  let imagePath = null;
  if (imageAction === 'delete') {
    if (!current.image) throw new RequestError(400, '此记录没有可删除的图片。');
    delete record.image;
    delete record.originalImage;
    delete record.imageWidth;
    delete record.imageHeight;
  } else if (imageAction === 'replace') {
    const image = changes.image;
    const bytes = decodeBase64(image.data);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new RequestError(413, '替换图片须大于 0 且不超过 8 MB。');
    const extension = imageExtension(bytes, image.mime);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    imagePath = `images/edit-${hex}.${extension}`;
    const blob = await github('/git/blobs', env, 'POST', { content: image.data, encoding: 'base64' });
    imageBlobSha = blob.sha;
    record.image = imagePath;
    delete record.originalImage;
    const width = Number(image.width);
    const height = Number(image.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 30000 || height > 30000) {
      throw new RequestError(400, '预览图片尺寸无效。');
    }
    record.imageWidth = width;
    record.imageHeight = height;
  }
  records[localIndex] = record;

  if (hasCategory || hasAddCategory) {
    const newCategories = categoriesOf(record);
    manifest.categoryCounts ||= {};
    manifest.categoryShards ||= {};
    for (const category of oldCategories) {
      if (!newCategories.includes(category)) manifest.categoryCounts[category] = Math.max(0, Number(manifest.categoryCounts[category] || 0) - 1);
    }
    for (const category of newCategories) {
      if (!oldCategories.includes(category)) manifest.categoryCounts[category] = Number(manifest.categoryCounts[category] || 0) + 1;
    }
    for (const category of new Set([...oldCategories, ...newCategories])) {
      const shouldInclude = records.some(item => categoriesOf(item).includes(category));
      const previous = Array.isArray(manifest.categoryShards[category]) ? manifest.categoryShards[category].filter(id => id !== shard.id) : [];
      if (shouldInclude) previous.push(shard.id);
      const shardOrder = new Map(manifest.shards.map((entry, i) => [entry.id, i]));
      previous.sort((a, b) => (shardOrder.get(a) ?? 0) - (shardOrder.get(b) ?? 0));
      if (shouldInclude || Number(manifest.categoryCounts[category] || 0) > 0) manifest.categoryShards[category] = previous;
      else delete manifest.categoryShards[category];
      if (Number(manifest.categoryCounts[category] || 0) <= 0) delete manifest.categoryCounts[category];
    }
    manifest.categories = Object.keys(manifest.categoryCounts).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  const tree = [
    { path: shardPath, mode: '100644', type: 'blob', content: `${JSON.stringify(records, null, 2)}\n` },
  ];
  if (hasCategory || hasAddCategory) tree.push({ path: manifestPath, mode: '100644', type: 'blob', content: `${JSON.stringify(manifest, null, 2)}\n` });
  if (imageBlobSha && imagePath) tree.push({ path: `${GALLERY}/${imagePath}`, mode: '100644', type: 'blob', sha: imageBlobSha });

  const ref = await github(`/git/ref/heads/${encodeURIComponent(BRANCH)}`, env);
  const parentSha = ref.object?.sha;
  if (!parentSha) throw new RequestError(502, '无法读取图库分支，未提交更改。');
  const parent = await github(`/git/commits/${parentSha}`, env);
  const newTree = await github('/git/trees', env, 'POST', { base_tree: parent.tree.sha, tree });
  const changed = [hasTitle ? 'title' : '', hasCategory ? 'theme' : '', hasAddCategory ? 'additional theme' : '', hasPrompts || hasNegativePrompts ? 'prompt' : '', imageAction !== 'none' ? 'image' : ''].filter(Boolean).join(', ');
  const commit = await github('/git/commits', env, 'POST', {
    message: `Gallery edit: ${changed} for record ${index}`,
    tree: newTree.sha,
    parents: [parentSha],
  });
  try {
    await github(`/git/refs/heads/${encodeURIComponent(BRANCH)}`, env, 'PATCH', { sha: commit.sha, force: false });
  } catch (error) {
    if (error instanceof RequestError && error.status === 409) throw error;
    throw new RequestError(409, 'GitHub 分支已发生变化。请刷新图库后检查；本次提交未覆盖其他提交。');
  }
  return { ok: true, recordIndex: index, commit: commit.sha, imagePath };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'paired-image-prompt-gallery-editor' }, 200, origin);
    }
    if (origin !== ALLOWED_ORIGIN) return json({ error: '来源不允许。' }, 403);
    if (url.pathname !== '/api/edit' || request.method !== 'POST') return json({ error: '未找到接口。' }, 404, origin);
    try {
      const result = await handleEdit(request, env);
      return json(result, 200, origin);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      const message = error instanceof RequestError ? error.message : '服务暂时无法完成提交，请稍后重试。';
      return json({ error: message }, status, origin);
    }
  },
};
