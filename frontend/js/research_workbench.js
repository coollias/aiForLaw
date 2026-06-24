const ResearchWorkbench = {
    answer: '',
    references: [],
    filter: 'all',
    isRunning: false,
    referencesSettled: false,
    selectedFiles: [],
    followups: [],
    conversation: [],
    currentRecordId: '',
    currentQuery: '',

    async init() {
        const auth = await API.checkAuth().catch(() => ({ authenticated: false }));
        if (!auth.authenticated) {
            document.getElementById('research-auth-page').classList.remove('hidden');
            return;
        }
        this.user = auth.user || null;
        this.applyTheme();
        document.getElementById('research-page').classList.remove('hidden');
        this.bind();
        this.loadHistory();
    },

    bind() {
        document.getElementById('research-clear-btn').addEventListener('click', () => this.clear());
        document.getElementById('research-copy-answer-btn').addEventListener('click', () => this.copyAnswer());
        document.getElementById('research-copy-refs-btn').addEventListener('click', () => this.copyReferences());
        document.getElementById('research-history-refresh').addEventListener('click', () => this.loadHistory());
        document.getElementById('research-file-input').addEventListener('change', () => {
            for (const file of document.getElementById('research-file-input').files) {
                this.addFile(file);
            }
            document.getElementById('research-file-input').value = '';
        });
        document.getElementById('research-followup-send').addEventListener('click', () => this.handleComposerSend());
        document.getElementById('research-followup-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.handleComposerSend();
            }
        });
        document.getElementById('research-history-list').addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('[data-delete-record]');
            if (deleteBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.deleteHistory(deleteBtn.dataset.deleteRecord);
                return;
            }
            const openBtn = e.target.closest('[data-open-record]');
            if (openBtn) {
                this.openHistory(openBtn.dataset.openRecord);
            }
        });
        document.getElementById('research-logout-btn').addEventListener('click', async () => {
            await API.logout();
            window.location.href = '/';
        });
        document.querySelectorAll('[data-ref-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-ref-filter]').forEach(item => item.classList.remove('active'));
                btn.classList.add('active');
                this.filter = btn.dataset.refFilter || 'all';
                this.renderReferences();
            });
        });
    },

    async submit(initialText = '') {
        if (this.isRunning) return;
        const composer = document.getElementById('research-followup-input');
        const input = (initialText || composer.value || '').trim();
        if (!input) {
            this.setStatus('请先输入检索问题。', 'failed');
            composer.focus();
            return;
        }

        this.isRunning = true;
        this.answer = '';
        this.references = [];
        this.referencesSettled = false;
        this.followups = [];
        this.currentRecordId = '';
        this.currentQuery = input;
        this.conversation = [
            { role: 'user', content: input },
            { role: 'assistant', content: '' },
        ];
        composer.value = '';
        this.renderAnswer();
        this.renderReferences();
        this.setRunning(true);
        this.setStatus('正在准备检索任务...', 'active');
        const filesToSend = await this.readFilesAsBase64();

        API.researchStream(
            {
                query: input,
                need_cases: document.getElementById('research-need-cases').checked,
                need_laws: document.getElementById('research-need-laws').checked,
                region: document.getElementById('research-region').value.trim(),
                date_start: document.getElementById('research-date-start').value || '',
                date_end: document.getElementById('research-date-end').value || '',
                focus: document.getElementById('research-focus').value,
                filter_strength: document.getElementById('research-filter-strength').value,
                files: filesToSend,
            },
            (chunk) => {
                this.answer += chunk;
                this.conversation[this.conversation.length - 1].content = this.answer;
                this.renderAnswer();
            },
            () => {
                this.isRunning = false;
                this.setRunning(false);
                this.setStatus('检索和分析完成。', 'done');
                this.renderAnswer(true);
                this.selectedFiles = [];
                this.renderFiles();
            },
            (error) => {
                this.isRunning = false;
                this.setRunning(false);
                this.setStatus(`检索失败：${error}`, 'failed');
            },
            (event) => {
                this.setStatus(event.status || '正在检索...', event?.tool?.stage === 'done' ? 'done' : 'active');
            },
            (refs, meta) => {
                this.addReferences(refs, meta);
            },
            (recordId) => {
                this.currentRecordId = recordId || '';
                this.loadHistory();
            }
        );
    },

    buildPrompt(input) {
        const needCases = document.getElementById('research-need-cases').checked;
        const needLaws = document.getElementById('research-need-laws').checked;
        const region = document.getElementById('research-region').value.trim();
        const focus = document.getElementById('research-focus').value;
        const requirements = [];

        if (region) requirements.push(`地域限制：${region}`);
        requirements.push(`输出侧重：${focus}`);
        if (needCases) {
            requirements.push('用户明确需要案例时，请输出尽量完整的案例信息：案名、法院、案号、案由、裁判日期、核心事实、争议焦点、裁判观点、参考价值；检索结果没有显示的字段请标注“检索结果未显示”。');
        }
        if (needLaws) {
            requirements.push('用户明确需要法条时，请输出法规名称、条号、条文内容、效力层级或时效信息、与本问题的适用关系；检索结果没有显示的字段请标注“检索结果未显示”。');
        }
        requirements.push('除列出材料外，还要回答用户提出的实体问题，不要只给检索列表。');

        return `${input}\n\n--- 工作台检索要求 ---\n${requirements.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
    },

    addFile(file) {
        const maxSize = 20 * 1024 * 1024;
        if (file.size > maxSize) {
            alert(`文件「${file.name}」超过 20MB 限制`);
            return;
        }
        if (this.selectedFiles.find(item => item.name === file.name && item.size === file.size)) return;
        this.selectedFiles.push(file);
        this.renderFiles();
    },

    removeFile(index) {
        this.selectedFiles.splice(index, 1);
        this.renderFiles();
    },

    renderFiles() {
        const list = document.getElementById('research-file-list');
        if (!this.selectedFiles.length) {
            list.classList.add('hidden');
            list.innerHTML = '';
            return;
        }
        list.classList.remove('hidden');
        list.innerHTML = this.selectedFiles.map((file, index) => `
            <span class="file-tag">
                <span class="file-tag-name" title="${this.escapeHtml(file.name)}">📎 ${this.escapeHtml(file.name)}</span>
                <span class="file-tag-remove" data-remove-file="${index}">×</span>
            </span>
        `).join('');
        list.querySelectorAll('[data-remove-file]').forEach(btn => {
            btn.addEventListener('click', () => this.removeFile(Number(btn.dataset.removeFile)));
        });
    },

    async readFilesAsBase64() {
        const files = [];
        for (const file of this.selectedFiles) {
            const item = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = reader.result;
                    const commaIdx = dataUrl.indexOf(',');
                    const mime = dataUrl.substring(5, dataUrl.indexOf(';'));
                    const b64 = dataUrl.substring(commaIdx + 1);
                    resolve({ name: file.name, mime_type: mime, data: b64 });
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            files.push(item);
        }
        return files;
    },

    addReferences(refs, meta = {}) {
        if (!Array.isArray(refs)) return;
        if (meta.replace_references) {
            this.references = [];
            this.referencesSettled = true;
        }
        const seen = new Set(this.references.map(ref => this.referenceKey(ref)));
        for (const ref of refs) {
            const pendingIndex = this.references.findIndex(item =>
                item.pending &&
                item.type === ref.type &&
                item.query === ref.query
            );
            if (pendingIndex >= 0) {
                this.references.splice(pendingIndex, 1, ref);
                seen.add(this.referenceKey(ref));
                continue;
            }
            const key = this.referenceKey(ref);
            if (seen.has(key)) continue;
            seen.add(key);
            this.references.push(ref);
        }
        this.renderReferences();
    },

    addReferencePlaceholder(event) {
        const tool = event?.tool || {};
        const name = tool.name || '';
        const query = tool.query || '';
        const stage = tool.stage || '';
        if (stage !== 'start' || !query) return;

        let type = '';
        if (name.includes('案例')) type = 'case';
        if (name.includes('法规') || name.includes('法条')) type = 'law';
        if (!type) return;

        const exists = this.references.some(ref => ref.type === type && ref.query === query);
        if (exists) return;

        this.references.push({
            id: `pending-${type}-${query}`,
            type,
            title: `${type === 'case' ? '案例材料' : '法条材料'}：${query.slice(0, 60)}`,
            query,
            reason: '正在检索',
            content: '正在检索材料，完成后会自动显示原始结果。',
            pending: true,
        });
        this.renderReferences();
    },

    async loadHistory() {
        const list = document.getElementById('research-history-list');
        if (!list) return;
        list.innerHTML = '<div class="history-empty">加载中...</div>';
        try {
            const data = await API.listResearchRecords();
            const records = data.records || [];
            if (!records.length) {
                list.innerHTML = '<div class="history-empty">暂无检索记录</div>';
                return;
            }
            list.innerHTML = records.map(record => {
                const dt = new Date((record.created_at || 0) * 1000);
                return `
                    <div class="research-history-item" data-record-id="${this.escapeHtml(record.id)}">
                        <button class="research-history-open" data-open-record="${this.escapeHtml(record.id)}">
                            <strong>${this.escapeHtml(record.title || '检索记录')}</strong>
                            <span>${record.case_count || 0} 案例 / ${record.law_count || 0} 法条 · ${dt.toLocaleString('zh-CN')}</span>
                        </button>
                        <button class="research-history-delete" data-delete-record="${this.escapeHtml(record.id)}" title="删除记录">×</button>
                    </div>
                `;
            }).join('');
        } catch (e) {
            list.innerHTML = `<div class="history-empty">记录加载失败：${this.escapeHtml(e.message)}</div>`;
        }
    },

    async openHistory(recordId) {
        if (!recordId || this.isRunning) return;
        try {
            const data = await API.getResearchRecord(recordId);
            const record = data.record || {};
            this.currentQuery = record.query || '';
            this.currentRecordId = record.id || recordId;
            this.answer = record.answer || '';
            if (Array.isArray(record.messages) && record.messages.length) {
                this.conversation = record.messages
                    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
                    .map(item => ({
                        role: item.role,
                        content: (item.content || '') + this.formatMessageFiles(item.files),
                    }));
            } else {
                this.conversation = [
                    { role: 'user', content: record.query || '历史检索' },
                    { role: 'assistant', content: this.answer },
                ];
            }
            const lastAssistant = [...this.conversation].reverse().find(item => item.role === 'assistant' && item.content);
            if (lastAssistant) this.answer = lastAssistant.content;
            this.references = record.references || [];
            this.referencesSettled = true;
            this.followups = [];
            this.renderAnswer(true);
            this.renderReferences();
            this.setStatus('已打开历史检索记录。', 'done');
        } catch (e) {
            this.setStatus(`打开记录失败：${e.message}`, 'failed');
        }
    },

    async deleteHistory(recordId) {
        if (!recordId || this.isRunning) return;
        if (!confirm('确定删除这条检索记录吗？')) return;
        try {
            await API.deleteResearchRecord(recordId);
            if (this.currentRecordId === recordId) {
                this.clear();
            }
            this.setStatus('已删除检索记录。', 'done');
            await this.loadHistory();
        } catch (e) {
            this.setStatus(`删除记录失败：${e.message}`, 'failed');
        }
    },

    referenceKey(ref) {
        return [
            ref?.id || '',
            ref?.type || '',
            ref?.query || '',
            (ref?.content || '').slice(0, 200),
        ].join('|');
    },

    renderAnswer(final = false) {
        const el = document.getElementById('research-answer');
        const subtitle = document.getElementById('research-answer-subtitle');
        if (!this.conversation.length) {
            el.className = 'research-chat-stream';
            el.innerHTML = '<div class="research-chat-empty">输入检索需求后，回答会显示在这里。案例和法条会在右侧单独展示。</div>';
            subtitle.textContent = '会结合检索材料回答你的问题';
            return;
        }
        el.className = 'research-chat-stream';
        el.innerHTML = this.conversation.map(item => `
            <div class="research-chat-message ${this.escapeHtml(item.role)}">
                <div class="research-chat-bubble">${this.renderMarkdown(item.content || (item.role === 'assistant' ? '正在分析...' : ''))}</div>
            </div>
        `).join('');
        el.scrollTop = el.scrollHeight;
        subtitle.textContent = final ? '回答已生成' : '正在生成回答...';
    },

    formatMessageFiles(files) {
        if (!Array.isArray(files) || !files.length) return '';
        const names = files
            .map(file => file && file.name)
            .filter(Boolean);
        return names.length ? `\n\n[附件：${names.join('、')}]` : '';
    },

    renderReferences() {
        const list = document.getElementById('research-reference-list');
        const subtitle = document.getElementById('research-reference-subtitle');
        const refs = this.references.filter(ref => this.filter === 'all' || ref.type === this.filter);
        const caseCount = this.references.filter(ref => ref.type === 'case').length;
        const lawCount = this.references.filter(ref => ref.type === 'law').length;
        subtitle.textContent = `案例 ${caseCount} 组，法条 ${lawCount} 组`;

        if (!this.references.length) {
            list.innerHTML = this.referencesSettled
                ? '<div class="empty-preview">本次检索没有抽取到可展示的具体案例/法条。可以调整关键词、地域或勾选法条后再试。</div>'
                : '<div class="empty-preview">检索完成后，这里会展示整理后的案例/法条材料。</div>';
            return;
        }
        if (!refs.length) {
            list.innerHTML = '<div class="empty-preview">当前筛选下没有材料。</div>';
            return;
        }

        list.innerHTML = refs.map((ref, index) => this.renderReferenceCard(ref, index)).join('');
    },

    renderReferenceCard(ref, index) {
        const type = ref.type === 'case' ? '案例' : '法条';
        const badgeClass = ref.type === 'case' ? 'case' : 'law';
        const title = ref.title || `${type}材料 ${index + 1}`;
        const query = ref.query || '';
        const reason = ref.reason || '';
        const content = ref.content || '未返回可展示的检索内容';
        const link = this.getReferenceLink(ref);
        const pendingClass = ref.pending ? ' pending' : '';
        let fields = ref.fields && typeof ref.fields === 'object'
            ? Object.entries(ref.fields).filter(([, value]) => String(value || '').trim())
            : [];
        fields = fields.sort((a, b) => {
            const ma = this.isMissingFieldValue(a[1]) ? 1 : 0;
            const mb = this.isMissingFieldValue(b[1]) ? 1 : 0;
            return ma - mb;
        });
        const score = !ref.raw_fallback && Number.isFinite(Number(ref.relevance_score))
            ? Number(ref.relevance_score)
            : null;
        const scoreText = ref.raw_fallback ? '<span class="reference-score raw">原始</span>' : (score !== null ? `<span class="reference-score">相关度 ${score}</span>` : '');
        const libraryLabels = {
            ordinary: '普通案例',
            authoritative: ref.authority_type && !this.isMissingFieldValue(ref.authority_type) ? ref.authority_type : '权威案例',
            mixed: '普通 + 权威',
            semantic: '语义召回',
        };
        const channelLabels = { semantic: '语义检索', ordinary: '普通库', authoritative: '权威库' };
        const originBadges = ref.type === 'case' ? `
            <span class="reference-origin-row">
                <span class="reference-origin library-${this.escapeHtml(ref.case_library || 'semantic')}">${this.escapeHtml(libraryLabels[ref.case_library] || '语义召回')}</span>
                ${(ref.matched_by || []).map(channel => `<span class="reference-origin channel">${this.escapeHtml(channelLabels[channel] || channel)}</span>`).join('')}
            </span>
        ` : '';

        return `
            <details class="reference-card research-ref-card${pendingClass}">
                <summary>
                    <span class="reference-badge ${badgeClass}">${type}</span>
                    <span class="reference-title">${this.escapeHtml(title)}</span>
                    <span class="reference-summary-meta">${scoreText}${originBadges}</span>
                </summary>
                ${link ? `<a class="reference-source-link" href="${this.escapeHtml(link)}" target="_blank" rel="noopener noreferrer">打开原始来源</a>` : ''}
                ${query ? `<div class="reference-meta"><strong>检索词</strong>${this.escapeHtml(query)}</div>` : ''}
                ${reason ? `<div class="reference-meta"><strong>${ref.raw_fallback ? '说明' : '相关性'}</strong>${this.escapeHtml(reason)}</div>` : ''}
                ${fields.length ? `
                    <div class="reference-fields">
                        ${fields.map(([key, value]) => `
                            <div>
                                <strong>${this.escapeHtml(key)}</strong>
                                <span>${this.renderFieldValue(key, value)}</span>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                <pre>${this.escapeHtml(content)}</pre>
            </details>
        `;
    },

    renderFieldValue(key, value) {
        if (value && typeof value === 'object') {
            return `<code class="reference-json-value">${this.escapeHtml(JSON.stringify(value, null, 2))}</code>`;
        }
        const text = String(value || '');
        const isLinkField = String(key || '').includes('链接') || /^https?:\/\//i.test(text);
        if (isLinkField && /^https?:\/\//i.test(text)) {
            const safe = this.escapeHtml(text);
            return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
        }
        return this.escapeHtml(text);
    },

    getReferenceLink(ref) {
        const direct = String(ref?.link || '').trim();
        if (/^https?:\/\//i.test(direct)) return direct;
        const fields = ref?.fields || {};
        for (const key of ['链接', '来源链接', '详情链接', 'url', 'link']) {
            const value = String(fields[key] || '').trim();
            if (/^https?:\/\//i.test(value)) return value;
        }
        return '';
    },

    isMissingFieldValue(value) {
        const text = String(value || '').trim();
        return !text || text === '未提取到信息' || text === '检索结果未显示';
    },

    setStatus(text, stage = 'active') {
        const list = document.getElementById('research-status-list');
        const item = document.createElement('div');
        item.className = `research-status-item ${stage}`;
        item.innerHTML = `
            <span>${stage === 'done' ? '✓' : stage === 'failed' ? '!' : '•'}</span>
            <p>${this.escapeHtml(text)}</p>
        `;
        list.prepend(item);
    },

    setRunning(running) {
        const btn = document.getElementById('research-followup-send');
        if (!btn) return;
        btn.disabled = running;
        btn.textContent = running ? '检索中...' : '发送';
    },

    clear() {
        if (this.isRunning) return;
        this.answer = '';
        this.references = [];
        this.referencesSettled = false;
        this.followups = [];
        this.conversation = [];
        this.currentRecordId = '';
        this.currentQuery = '';
        this.selectedFiles = [];
        document.getElementById('research-followup-input').value = '';
        document.getElementById('research-status-list').innerHTML = '';
        document.getElementById('research-answer-subtitle').textContent = '会结合检索材料回答你的问题';
        this.renderFiles();
        this.renderAnswer();
        this.renderReferences();
    },

    handleComposerSend() {
        const input = document.getElementById('research-followup-input');
        const text = (input.value || '').trim();
        if (!text && !this.selectedFiles.length) return;
        if (!this.answer.trim() && !this.references.length) {
            input.value = '';
            this.submit(text);
            return;
        }
        this.askFollowup();
    },

    async askFollowup() {
        if (this.isRunning) return;
        const input = document.getElementById('research-followup-input');
        const question = (input.value || '').trim();
        if (!question) return;
        if (!this.answer.trim() && !this.references.length) {
            this.setStatus('请先完成一次检索，再继续追问。', 'failed');
            return;
        }
        input.value = '';
        const filesToSend = await this.readFilesAsBase64();
        const conversationContext = this.conversation.map(item => ({
            role: item.role,
            content: item.content || '',
        }));
        const fileNote = this.selectedFiles.length ? `\n\n[附件：${this.selectedFiles.map(file => file.name).join('、')}]` : '';
        this.conversation.push({ role: 'user', content: question + fileNote });
        const assistantIndex = this.conversation.push({ role: 'assistant', content: '正在分析...' }) - 1;
        this.renderAnswer();
        this.selectedFiles = [];
        this.renderFiles();

        API.researchFollowupStream(
            {
                question,
                query: this.currentQuery,
                answer: this.answer,
                references: this.references,
                files: filesToSend,
                record_id: this.currentRecordId,
                conversation: conversationContext,
            },
            (chunk) => {
                const current = this.conversation[assistantIndex].content === '正在分析...' ? '' : this.conversation[assistantIndex].content;
                this.conversation[assistantIndex].content = current + chunk;
                this.renderAnswer(true);
            },
            () => {
                this.answer = this.conversation[assistantIndex].content || this.answer;
                if (this.currentRecordId) this.loadHistory();
                this.setStatus('追问已完成。', 'done');
            },
            (error) => {
                this.conversation[assistantIndex].content = `追问失败：${error}`;
                this.renderAnswer(true);
                this.setStatus(`追问失败：${error}`, 'failed');
            }
        );
    },

    async copyAnswer() {
        if (!this.answer.trim()) return;
        await navigator.clipboard.writeText(this.answer);
        this.setStatus('已复制回答。', 'done');
    },

    async copyReferences() {
        if (!this.references.length) return;
        const text = this.references.map((ref, index) => {
            const type = ref.type === 'case' ? '案例' : '法条';
            return `【${index + 1}. ${type}】${ref.title || ''}\n检索词：${ref.query || ''}\n目的：${ref.reason || ''}\n${ref.content || ''}`;
        }).join('\n\n');
        await navigator.clipboard.writeText(text);
        this.setStatus('已复制检索材料。', 'done');
    },

    renderMarkdown(text) {
        if (typeof marked === 'undefined') return this.escapeHtml(text).replace(/\n/g, '<br>');
        try {
            return marked.parse(text, { breaks: true, gfm: true });
        } catch (e) {
            return this.escapeHtml(text).replace(/\n/g, '<br>');
        }
    },

    applyTheme() {
        const username = this.user?.username || '';
        document.body.classList.toggle('theme-cold', !!username && username !== 'loveHmt');
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    },
};

document.addEventListener('DOMContentLoaded', () => ResearchWorkbench.init());
