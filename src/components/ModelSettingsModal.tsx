import { useEffect, useState } from 'react';
import {
  ARK_DEFAULT_BASE_URLS,
  ARK_IMAGE_DEFAULT_BASE_URL,
  SEEDREAM_5_MODEL_ID,
  type ArkProtocol,
} from '../shared/constants';
import {
  imageApiKeyOf,
  isValidBaseUrl,
  isValidEndpoint,
  textApiKeyOf,
} from '../shared/security';
import type { ModelSettings } from '../shared/types';
import { generateImage, testConnection } from '../model/arkClient';

type Props = {
  open: boolean;
  initial: ModelSettings | null;
  onSave: (s: ModelSettings) => void;
  onClear: () => void;
  onClose: () => void;
  /** 设置页内嵌表单。不套对话框，保存后仍留在页面上。 */
  embedded?: boolean;
};

const PROTOCOL_LABELS: Record<ArkProtocol, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function buildDraft(fields: {
  imageApiKey: string;
  textApiKey: string;
  seedEndpoint: string;
  imageEndpoint: string;
  imageBaseUrl: string;
  protocol: ArkProtocol;
  baseUrl: string;
}): ModelSettings {
  const imageApiKey = fields.imageApiKey.trim();
  const textApiKey = fields.textApiKey.trim();
  return {
    apiKey: imageApiKey || textApiKey,
    imageApiKey,
    textApiKey,
    seedEndpoint: fields.seedEndpoint.trim(),
    imageEndpoint: fields.imageEndpoint.trim(),
    imageBaseUrl: fields.imageBaseUrl.trim(),
    protocol: fields.protocol,
    baseUrl: fields.baseUrl.trim(),
  };
}

export function ModelSettingsModal({ open, initial, onSave, onClear, onClose, embedded = false }: Props) {
  const [imageApiKey, setImageApiKey] = useState('');
  const [textApiKey, setTextApiKey] = useState('');
  const [seedEndpoint, setSeedEndpoint] = useState('');
  const [imageEndpoint, setImageEndpoint] = useState('');
  const [protocol, setProtocol] = useState<ArkProtocol>('openai');
  const [baseUrl, setBaseUrl] = useState(ARK_DEFAULT_BASE_URLS.openai);
  const [imageBaseUrl, setImageBaseUrl] = useState(ARK_IMAGE_DEFAULT_BASE_URL);
  const [showImageKey, setShowImageKey] = useState(false);
  const [showTextKey, setShowTextKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [imageTesting, setImageTesting] = useState(false);
  const [imageTestMsg, setImageTestMsg] = useState<string | null>(null);
  const [imageTestOk, setImageTestOk] = useState<boolean | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open && !embedded) return;
    setImageApiKey(imageApiKeyOf(initial));
    setTextApiKey(textApiKeyOf(initial));
    setSeedEndpoint(initial?.seedEndpoint ?? '');
    setImageEndpoint(initial?.imageEndpoint ?? '');
    setProtocol(initial?.protocol ?? 'openai');
    setBaseUrl(initial?.baseUrl ?? ARK_DEFAULT_BASE_URLS[initial?.protocol ?? 'openai']);
    setImageBaseUrl(initial?.imageBaseUrl ?? ARK_IMAGE_DEFAULT_BASE_URL);
    setTestMsg(null);
    setTestOk(null);
    setImageTestMsg(null);
    setImageTestOk(null);
    setFormError(null);
  }, [open, embedded, initial]);

  if (!embedded && !open) return null;

  const imageEndpointTrim = imageEndpoint.trim();
  const imageEndpointOk = imageEndpointTrim.length === 0 || isValidEndpoint(imageEndpointTrim);
  const endpointOk = isValidEndpoint(seedEndpoint.trim());
  const baseOk = isValidBaseUrl(baseUrl.trim());
  const imageBaseOk = isValidBaseUrl(imageBaseUrl.trim());

  function draftFromForm(): ModelSettings {
    return buildDraft({
      imageApiKey,
      textApiKey,
      seedEndpoint,
      imageEndpoint,
      imageBaseUrl,
      protocol,
      baseUrl,
    });
  }

  function switchProtocol(next: ArkProtocol) {
    setProtocol(next);
    setBaseUrl(ARK_DEFAULT_BASE_URLS[next]);
    setTestMsg(null);
    setTestOk(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestMsg(null);
    const draft = draftFromForm();
    if (!draft.textApiKey || !draft.seedEndpoint) {
      setTestOk(false);
      setTestMsg('请先填写文本通道的 API Key 和 Endpoint');
      setTesting(false);
      return;
    }
    if (!isValidEndpoint(draft.seedEndpoint)) {
      setTestOk(false);
      setTestMsg('文本 Endpoint 不合法：只允许接入点 ID（如 ep-xxxx），不允许填写 URL/路径');
      setTesting(false);
      return;
    }
    if (!isValidBaseUrl(draft.baseUrl)) {
      setTestOk(false);
      setTestMsg('文本 Base URL 不合法：仅允许火山方舟官方 https 域名（.volces.com）');
      setTesting(false);
      return;
    }
    const r = await testConnection(draft);
    setTesting(false);
    if ('ok' in r && r.ok) {
      setTestOk(true);
      setTestMsg(
        `文本模型连接成功（${protocol} 协议，HTTP 200${
          r.diagnostics.durationMs ? `，${r.diagnostics.durationMs}ms` : ''
        }${r.diagnostics.requestId ? `，requestId ${r.diagnostics.requestId}` : ''}）`,
      );
    } else {
      setTestOk(false);
      setTestMsg(`文本模型连接失败 · ${r.errorClass}：${r.message}`);
    }
  }

  async function handleImageTest() {
    setImageTestMsg(null);
    const draft = draftFromForm();
    if (!draft.imageApiKey || !draft.imageEndpoint) {
      setImageTestOk(false);
      setImageTestMsg('请先填写图片通道的 API Key 和模型 ID');
      return;
    }
    if (!isValidEndpoint(draft.imageEndpoint) || !isValidBaseUrl(draft.imageBaseUrl ?? '')) {
      setImageTestOk(false);
      setImageTestMsg('图片模型 ID 或图片 Base URL 不合法');
      return;
    }
    if (!window.confirm('图片模型实测会生成 1 张 2K 图片并产生费用，确认继续吗？')) return;
    setImageTesting(true);
    const result = await generateImage(
      draft,
      '一件白色无标识商品放在纯白背景中央，电商产品摄影，主体完整清晰',
      { size: '2048x2048', count: 1 },
    );
    setImageTesting(false);
    setImageTestOk(result.ok);
    setImageTestMsg(result.ok ? '图片模型可用：已成功生成 1 张 2K 测试图' : `图片模型失败：${result.message}`);
  }

  function handleSave() {
    const draft = draftFromForm();
    const imagePartial = Number(!!draft.imageApiKey) + Number(!!draft.imageEndpoint) === 1;
    const textPartial = Number(!!draft.textApiKey) + Number(!!draft.seedEndpoint) === 1;
    if (imagePartial) {
      setFormError('图片通道请同时填写 API Key 和模型 ID');
      return;
    }
    if (textPartial) {
      setFormError('文本通道请同时填写 API Key 和 Endpoint');
      return;
    }
    if (!draft.imageApiKey && !draft.textApiKey) {
      setFormError('请至少配好图片或文本中的一条通道');
      return;
    }
    if (!draft.imageEndpoint && !draft.seedEndpoint) {
      setFormError('请至少填写图片模型或文本 Endpoint');
      return;
    }
    if (draft.imageEndpoint && !isValidEndpoint(draft.imageEndpoint)) {
      setFormError('图片模型不合法：只允许接入点/模型 ID，不允许填写 URL/路径');
      return;
    }
    if (draft.seedEndpoint && !isValidEndpoint(draft.seedEndpoint)) {
      setFormError('文本 Endpoint 不合法：不允许填写 http(s):// 或带路径的地址');
      return;
    }
    if (!isValidBaseUrl(draft.imageBaseUrl ?? '')) {
      setFormError('图片 Base URL 不合法：仅允许火山方舟官方 https 域名（.volces.com）');
      return;
    }
    if (!isValidBaseUrl(draft.baseUrl)) {
      setFormError('文本 Base URL 不合法：仅允许火山方舟官方 https 域名（.volces.com）');
      return;
    }
    onSave(draft);
    if (!embedded) onClose();
  }

  function handleClear() {
    onClear();
    setImageApiKey('');
    setTextApiKey('');
    setSeedEndpoint('');
    setImageEndpoint('');
    setProtocol('openai');
    setBaseUrl(ARK_DEFAULT_BASE_URLS.openai);
    setImageBaseUrl(ARK_IMAGE_DEFAULT_BASE_URL);
    setTestMsg(null);
    setTestOk(null);
    setImageTestMsg(null);
    setImageTestOk(null);
  }

  const savedImageKey = imageApiKeyOf(initial);
  const savedTextKey = textApiKeyOf(initial);

  const body = (
    <div className="settings-modal-body">
      {!embedded && <h2>模型设置</h2>}

      <div className="settings-channels">
        <section className="settings-channel is-image" data-testid="image-channel">
          <header className="settings-channel-head">
            <h3>图片生成</h3>
            <button
              type="button"
              className="btn sm"
              onClick={handleImageTest}
              disabled={imageTesting}
              data-testid="image-test-btn"
            >
              {imageTesting ? '测试中…' : '测试'}
            </button>
          </header>
          <label className="field">
            <span>API Key</span>
            <div className="settings-key-row">
              <input
                type={showImageKey ? 'text' : 'password'}
                value={imageApiKey}
                placeholder="Platform API Key"
                onChange={(e) => setImageApiKey(e.target.value)}
                data-testid="image-apikey-input"
                autoComplete="off"
              />
              <button type="button" className="btn sm" onClick={() => setShowImageKey((v) => !v)}>
                {showImageKey ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
          <label className="field">
            <span>模型</span>
            <div className="settings-key-row">
              <input
                type="text"
                value={imageEndpoint}
                placeholder={SEEDREAM_5_MODEL_ID}
                onChange={(e) => setImageEndpoint(e.target.value)}
                data-testid="imageendpoint-input"
              />
              <button
                type="button"
                className="btn sm"
                onClick={() => setImageEndpoint(SEEDREAM_5_MODEL_ID)}
                data-testid="use-seedream-5"
              >
                Seedream 5.0
              </button>
            </div>
            {imageEndpointTrim.length > 0 && !imageEndpointOk && (
              <span className="hint err">只能填写模型 ID，不能是 URL</span>
            )}
          </label>
          <label className="field">
            <span>Base URL</span>
            <input
              type="text"
              value={imageBaseUrl}
              onChange={(event) => setImageBaseUrl(event.target.value)}
              data-testid="image-baseurl-input"
            />
            {!imageBaseOk && <span className="hint err">仅允许火山方舟官方 https 域名</span>}
          </label>
          {imageTestMsg && (
            <p className={imageTestOk ? 'okbox' : 'hint err'} data-testid="image-test-result">
              {imageTestMsg}
            </p>
          )}
        </section>

        <section className="settings-channel is-text" data-testid="text-channel">
          <header className="settings-channel-head">
            <h3>文本模型</h3>
            <button
              type="button"
              className="btn sm"
              onClick={handleTest}
              disabled={testing}
              data-testid="text-test-btn"
            >
              {testing ? '测试中…' : '测试'}
            </button>
          </header>
          <label className="field">
            <span>API Key</span>
            <div className="settings-key-row">
              <input
                type={showTextKey ? 'text' : 'password'}
                value={textApiKey}
                placeholder="可与图片 Key 不同"
                onChange={(e) => setTextApiKey(e.target.value)}
                data-testid="text-apikey-input"
                autoComplete="off"
              />
              <button type="button" className="btn sm" onClick={() => setShowTextKey((v) => !v)}>
                {showTextKey ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
          <label className="field">
            <span>Endpoint</span>
            <input
              type="text"
              value={seedEndpoint}
              placeholder="ep-xxxxxxxx"
              onChange={(e) => setSeedEndpoint(e.target.value)}
              data-testid="endpoint-input"
            />
            {seedEndpoint.length > 0 && !endpointOk && (
              <span className="hint err">只能填写接入点 ID，不能是 URL</span>
            )}
          </label>
          <div className="settings-text-row">
            <label className="field">
              <span>协议</span>
              <select
                value={protocol}
                onChange={(e) => switchProtocol(e.target.value as ArkProtocol)}
                data-testid="protocol-select"
              >
                {(Object.keys(PROTOCOL_LABELS) as ArkProtocol[]).map((p) => (
                  <option key={p} value={p} data-testid={`protocol-${p}`}>
                    {PROTOCOL_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Base URL</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                data-testid="baseurl-input"
              />
              {baseUrl.length > 0 && !baseOk && (
                <span className="hint err">仅允许火山方舟官方 https 域名</span>
              )}
            </label>
          </div>
          {testMsg && (
            <p className={testOk ? 'okbox' : 'hint err'} data-testid="test-result">
              {testMsg}
            </p>
          )}
        </section>
      </div>
    </div>
  );

  const foot = (
    <div className="settings-modal-foot">
      {formError && (
        <div className="settings-modal-alerts">
          <p className="hint err">{formError}</p>
        </div>
      )}
      <div className="modal-actions">
        <div className="settings-foot-left">
          {(savedImageKey || savedTextKey) && (
            <button type="button" className="btn danger" onClick={handleClear}>
              断开并清除 Key
            </button>
          )}
        </div>
        <div className="settings-foot-right">
          {!embedded && (
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
          )}
          <button type="button" className="btn primary" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="settings-embed settings-modal" data-testid="settings-form">
        {body}
        {foot}
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-label="模型设置" data-testid="settings-modal">
        {body}
        {foot}
      </div>
    </div>
  );
}
