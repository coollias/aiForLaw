/**
 * AI 法律小助手 — 聊天功能（含附件上传）
 */

const Chat = {
    isStreaming: false,
    selectedFiles: [],

    init() {
        this.el = {
            messages: document.getElementById('messages'),
            chatArea: document.getElementById('chat-area'),
            welcome: document.getElementById('welcome-msg'),
            input: document.getElementById('chat-input'),
            sendBtn: document.getElementById('send-btn'),
            typing: document.getElementById('typing-indicator'),
            fileInput: document.getElementById('file-input'),
            attachBtn: document.getElementById('attach-btn'),
            selectedFiles: document.getElementById('selected-files'),
            webSearchToggle: document.getElementById('web-search-toggle'),
        };
        this.webSearchEnabled = false;

        // 联网搜索开关
        if (this.el.webSearchToggle) {
            this.el.webSearchToggle.addEventListener('click', (e) => {
                this.toggleWebSearch();
            });
        }

        // 发送
        this.el.sendBtn.addEventListener('click', () => this.send());
        this.el.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.send();
            }
        });

        // 粘贴图片（从剪贴板）
        this.el.input.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    this.addFile(file);
                }
            }
        });

        // 拖拽文件
        this.el.chatArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.el.chatArea.style.background = 'rgba(249,124,147,0.05)';
        });
        this.el.chatArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.el.chatArea.style.background = '';
        });
        this.el.chatArea.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.el.chatArea.style.background = '';
            if (e.dataTransfer?.files) {
                for (const file of e.dataTransfer.files) {
                    this.addFile(file);
                }
            }
        });

        // 附件按钮
        this.el.attachBtn.addEventListener('click', () => this.el.fileInput.click());
        this.el.fileInput.addEventListener('change', () => {
            for (const file of this.el.fileInput.files) {
                this.addFile(file);
            }
            this.el.fileInput.value = '';
        });

        // 自适应输入框
        this.el.input.addEventListener('input', () => {
            this.el.input.style.height = 'auto';
            this.el.input.style.height = Math.min(this.el.input.scrollHeight, 120) + 'px';
        });
    },

    toggleWebSearch() {
        this.webSearchEnabled = !this.webSearchEnabled;
        const btn = this.el.webSearchToggle;
        if (btn) {
            btn.classList.toggle('active', this.webSearchEnabled);
        }
    },

    addFile(file) {
        const maxSize = 20 * 1024 * 1024; // 20MB
        if (file.size > maxSize) {
            alert(`文件「${file.name}」超过 20MB 限制`);
            return;
        }
        // 避免重复
        if (this.selectedFiles.find(f => f.name === file.name && f.size === file.size)) {
            return;
        }
        this.selectedFiles.push(file);
        this.renderFileTags();
    },

    removeFile(index) {
        this.selectedFiles.splice(index, 1);
        this.renderFileTags();
    },

    renderFileTags() {
        if (this.selectedFiles.length === 0) {
            this.el.selectedFiles.classList.add('hidden');
            this.el.selectedFiles.innerHTML = '';
            return;
        }
        this.el.selectedFiles.classList.remove('hidden');
        this.el.selectedFiles.innerHTML = this.selectedFiles.map((f, i) => `
            <span class="file-tag">
                <span class="file-tag-name" title="${this.escapeHtml(f.name)}">${this.getFileIcon(f.name)} ${this.escapeHtml(f.name)}</span>
                <span class="file-tag-remove" onclick="Chat.removeFile(${i})">✕</span>
            </span>
        `).join('');
    },

    getFileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        const map = { pdf: '📕', doc: '📘', docx: '📘', txt: '📄', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', bmp: '🖼️' };
        return map[ext] || '📎';
    },

    async readFilesAsBase64() {
        const files = [];
        for (const file of this.selectedFiles) {
            const b64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    // data:xxx;base64,xxx → 只取后缀和纯 base64
                    const dataUrl = reader.result;
                    const commaIdx = dataUrl.indexOf(',');
                    const mime = dataUrl.substring(5, dataUrl.indexOf(';'));
                    const b64 = dataUrl.substring(commaIdx + 1);
                    resolve({ name: file.name, mime_type: mime, data: b64 });
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            files.push(b64);
        }
        return files;
    },

    async send() {
        if (this.isStreaming) return;

        const message = this.el.input.value.trim();
        const hasFiles = this.selectedFiles.length > 0;
        if (!message && !hasFiles) return;

        // 读取附件为 base64（必须在清空前完成）
        let filesToSend = [];
        if (hasFiles) {
            filesToSend = await this.readFilesAsBase64();
        }

        // 隐藏欢迎消息
        this.el.welcome.classList.add('hidden');

        // 渲染用户消息
        const displayText = message || (hasFiles ? `发送了 ${this.selectedFiles.length} 个文件` : '');
        this.renderMessage('user', displayText, this.selectedFiles);

        // 清空
        this.el.input.value = '';
        this.el.input.style.height = 'auto';
        this.selectedFiles = [];
        this.renderFileTags();

        // 加载动画
        this.el.typing.classList.remove('hidden');

        const aiMsgEl = this.createAIMessagePlaceholder();
        let fullContent = '';
        this.isStreaming = true;
        this.el.sendBtn.disabled = true;

        const scene = App.currentScene || 'general';

        API.chatStream(
            message,
            scene,
            filesToSend,
            // onChunk
            (chunk) => {
                fullContent += chunk;
                this.updateAIMessage(aiMsgEl, fullContent);
                this.scrollToBottom();
            },
            // onDone
            () => {
                this.el.typing.classList.add('hidden');
                this.isStreaming = false;
                this.el.sendBtn.disabled = false;
                this.el.input.focus();
                this.setAIStatus(aiMsgEl, '');
                this.finalizeAIMessage(aiMsgEl, fullContent);
                if (typeof App !== 'undefined' && App.loadSessions) {
                    App.loadSessions().catch(() => {});
                }
            },
            // onError
            (error) => {
                this.el.typing.classList.add('hidden');
                this.isStreaming = false;
                this.el.sendBtn.disabled = false;
                this.el.input.focus();
                this.setAIStatus(aiMsgEl, '');
                const contentEl = aiMsgEl.querySelector('.msg-content');
                contentEl.classList.remove('hidden');
                contentEl.textContent = '😅 抱歉，出了点问题：' + error;
            },
            // onStatus
            (event) => {
                this.setAIStatus(aiMsgEl, event);
                this.scrollToBottom();
            },
            // onReferences
            (references) => {
                this.addReferences(aiMsgEl, references);
                this.scrollToBottom();
            },
            { webSearchEnabled: this.webSearchEnabled }
        );
    },

    sendQuick(message) {
        this.el.input.value = message;
        this.send();
    },

    renderMessage(role, content, files) {
        const div = document.createElement('div');
        div.className = `message ${role}`;
        const avatar = role === 'user' ? '👩‍💼' : '🌸';
        let fileHtml = '';
        if (files && files.length > 0) {
            fileHtml = files.map(f =>
                `<span class="file-attachment">📎 ${this.escapeHtml(f.name)}</span>`
            ).join('');
        }
        div.innerHTML = `
            <div class="msg-avatar">${avatar}</div>
            <div class="msg-content">${fileHtml}${content ? this.escapeHtml(content) : ''}</div>
        `;
        this.el.messages.appendChild(div);
        this.scrollToBottom();
    },

    createAIMessagePlaceholder() {
        const div = document.createElement('div');
        div.className = 'message assistant';
        div.innerHTML = `
            <div class="msg-avatar">🌸</div>
            <div class="msg-body">
                <div class="msg-content hidden"></div>
                <div class="msg-references hidden"></div>
                <div class="msg-status hidden"></div>
            </div>
        `;
        this.el.messages.appendChild(div);
        return div;
    },

    setAIStatus(el, event) {
        const statusEl = el.querySelector('.msg-status');
        if (!statusEl) return;
        const text = typeof event === 'string' ? event : (event?.status || '');
        if (!text) {
            statusEl.classList.add('hidden');
            statusEl.innerHTML = '';
            return;
        }
        const stage = event?.tool?.stage || (text.includes('完成') ? 'done' : 'active');
        const toolName = event?.tool?.name || '';
        const isPlanning = toolName.includes('计划') || text.includes('拆解') || text.includes('计划');
        const isSearching = toolName.includes('检索') || text.includes('检索') || text.includes('调用');
        const title = stage === 'done'
            ? `${toolName || '任务'}已完成`
            : isPlanning
                ? '正在规划检索路径'
                : isSearching
                    ? `正在执行${toolName || '检索'}`
                    : '正在分析问题';
        const icon = stage === 'done' ? '✓' : (isSearching ? '⌕' : '•');
        const detail = event?.tool?.query || '';
        statusEl.classList.remove('hidden');
        statusEl.classList.toggle('done', stage === 'done');
        statusEl.innerHTML = `
            <span class="status-orbit"><span>${icon}</span></span>
            <span class="status-copy">
                <span class="status-kicker">AI 工作流</span>
                <span class="status-label">${this.escapeHtml(title)}</span>
                <span class="status-detail">${this.escapeHtml(text)}</span>
                ${detail ? `<span class="status-chip">${this.escapeHtml(detail)}</span>` : ''}
            </span>
        `;
    },

    updateAIMessage(el, content) {
        const ce = el.querySelector('.msg-content');
        ce.classList.remove('hidden');
        ce.innerHTML = this.renderMarkdown(content) || '<span class="cursor-blink">|</span>';
    },

    finalizeAIMessage(el, content) {
        const ce = el.querySelector('.msg-content');
        ce.classList.remove('hidden');
        ce.innerHTML = this.renderMarkdown(content);
        this.addActionButtons(el, content);
    },

    renderMarkdown(text) {
        if (typeof marked === 'undefined') return text.replace(/\n/g, '<br>');
        try {
            return marked.parse(text, { breaks: true, gfm: true });
        } catch (e) {
            return text.replace(/\n/g, '<br>');
        }
    },

    addReferences(el, references) {
        if (!Array.isArray(references) || references.length === 0) return;
        if (!el._researchReferences) el._researchReferences = [];
        const seen = new Set(el._researchReferences.map(ref => this.referenceKey(ref)));
        for (const ref of references) {
            const key = this.referenceKey(ref);
            if (seen.has(key)) continue;
            seen.add(key);
            el._researchReferences.push(ref);
        }
        this.renderReferences(el);
    },

    referenceKey(ref) {
        return [
            ref?.id || '',
            ref?.type || '',
            ref?.query || '',
            (ref?.content || '').slice(0, 160),
        ].join('|');
    },

    renderReferences(el) {
        const box = el.querySelector('.msg-references');
        const refs = el._researchReferences || [];
        if (!box || refs.length === 0) return;

        const caseCount = refs.filter(ref => ref.type === 'case').length;
        const lawCount = refs.filter(ref => ref.type === 'law').length;
        const webCount = refs.filter(ref => ref.type === 'web').length;
        const summary = [
            caseCount ? `${caseCount} 组案例材料` : '',
            lawCount ? `${lawCount} 组法条材料` : '',
            webCount ? `${webCount} 组联网搜索结果` : '',
        ].filter(Boolean).join('，');

        box.classList.remove('hidden');
        box.innerHTML = `
            <div class="reference-panel-title">
                <span>检索材料</span>
                <small>${this.escapeHtml(summary || `${refs.length} 组材料`)}</small>
            </div>
            <div class="reference-list">
                ${refs.map((ref, index) => this.renderReferenceCard(ref, index)).join('')}
            </div>
        `;
    },

    renderReferenceCard(ref, index) {
        const type = ref.type === 'case' ? '案例' : (ref.type === 'web' ? '网络' : '法条');
        const badgeClass = ref.type === 'case' ? 'case' : (ref.type === 'web' ? 'web' : 'law');
        const title = ref.title || `${type}材料 ${index + 1}`;
        const reason = ref.reason || '';
        const query = ref.query || '';
        const content = ref.content || '未返回可展示的检索内容';

        return `
            <details class="reference-card" ${index === 0 ? 'open' : ''}>
                <summary>
                    <span class="reference-badge ${badgeClass}">${type}</span>
                    <span class="reference-title">${this.escapeHtml(title)}</span>
                </summary>
                ${query ? `<div class="reference-meta"><strong>检索词</strong>${this.escapeHtml(query)}</div>` : ''}
                ${reason ? `<div class="reference-meta"><strong>目的</strong>${this.escapeHtml(reason)}</div>` : ''}
                <pre>${this.escapeHtml(content)}</pre>
            </details>
        `;
    },

    addActionButtons(el, content) {
        const docPatterns = ['起诉状', '答辩状', '法律意见书', '合同', '协议', '律师函'];
        const isDoc = docPatterns.some(p => content.includes(p));
        const isLong = content.length > 500;
        if (isDoc && isLong) {
            const contentEl = el.querySelector('.msg-content');
            const btnDiv = document.createElement('div');
            btnDiv.style.textAlign = 'right';
            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'download-btn';
            downloadBtn.innerHTML = '📥 下载 Word 文档';
            downloadBtn.addEventListener('click', async () => {
                const title = this.extractTitle(content) || '法律文书';
                downloadBtn.textContent = '⏳ 生成中...';
                downloadBtn.disabled = true;
                try {
                    await API.exportWord(content, title);
                    downloadBtn.textContent = '✅ 下载完成';
                } catch (e) {
                    downloadBtn.textContent = '❌ 下载失败，请重试';
                    downloadBtn.disabled = false;
                }
            });
            btnDiv.appendChild(downloadBtn);
            contentEl.appendChild(btnDiv);
        }
    },

    extractTitle(content) {
        const m = content.match(/^#\s+(.+)/m) || content.match(/^(.+起诉状|.+答辩状|.+意见书|.+合同|.+协议|.+律师函)/m);
        return m ? m[1].trim() : '法律文书';
    },

    clear(options = {}) {
        const { remote = true } = options;
        this.el.messages.innerHTML = '';
        this.el.welcome.classList.remove('hidden');
        this.selectedFiles = [];
        this.renderFileTags();
        if (remote) {
            API.clearChat().catch(() => {});
        }
    },

    scrollToBottom() {
        this.el.chatArea.scrollTop = this.el.chatArea.scrollHeight;
    },

    escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    },
};
