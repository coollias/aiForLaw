const ContractWorkbench = {
    file: null,
    filePayload: null,
    pdfDoc: null,
    pageNum: 1,
    pageRendering: false,
    pendingPage: null,
    review: null,
    sortedIssues: [],
    currentParsedDoc: null,
    currentDocumentId: '',
    parties: [],
    isParsing: false,
    followups: [],
    currentRecord: null,
    jobProgressTimer: null,
    jobProgressState: null,
    jobProgressStartedAt: 0,
    optimisticProgress: 0,

    init() {
        this.el = {
            page: document.getElementById('contract-workbench'),
            chat: document.getElementById('chat-area'),
            inputArea: document.querySelector('.input-area'),
            uploadZone: document.getElementById('contract-upload-zone'),
            fileInput: document.getElementById('contract-file-input'),
            fileName: document.getElementById('contract-file-name'),
            contractType: document.getElementById('contract-type-select'),
            issueLimit: document.getElementById('contract-issue-limit-select'),
            partyPanel: document.getElementById('contract-party-panel'),
            partyStatus: document.getElementById('contract-party-status'),
            partyList: document.getElementById('contract-party-list'),
            perspective: document.getElementById('contract-perspective-select'),
            customPartyField: document.getElementById('contract-custom-party-field'),
            customPartyInput: document.getElementById('contract-custom-party-input'),
            referenceEnabled: document.getElementById('contract-reference-enabled'),
            note: document.getElementById('contract-note'),
            reviewBtn: document.getElementById('contract-review-btn'),
            status: document.getElementById('contract-review-status'),
            summary: document.getElementById('contract-summary'),
            issues: document.getElementById('contract-issues'),
            followupPanel: document.getElementById('contract-followup-panel'),
            followupList: document.getElementById('contract-followup-list'),
            followupInput: document.getElementById('contract-followup-input'),
            followupSend: document.getElementById('contract-followup-send'),
            jobProgress: document.getElementById('contract-job-progress'),
            jobTitle: document.getElementById('contract-job-title'),
            jobPercent: document.getElementById('contract-job-percent'),
            jobBar: document.getElementById('contract-job-bar'),
            jobMessage: document.getElementById('contract-job-message'),
            canvas: document.getElementById('contract-pdf-canvas'),
            renderedDoc: document.getElementById('contract-rendered-doc'),
            empty: document.getElementById('contract-empty-preview'),
            pageInfo: document.getElementById('contract-page-info'),
            prev: document.getElementById('contract-prev-page'),
            next: document.getElementById('contract-next-page'),
            back: document.getElementById('contract-back-btn'),
            highlight: document.getElementById('contract-page-highlight'),
            historyList: document.getElementById('contract-history-list'),
            historyRefresh: document.getElementById('contract-history-refresh'),
        };
        if (!this.el.page) return;
        this.el.fileInput.addEventListener('change', () => this.handleFile());
        this.el.reviewBtn.addEventListener('click', () => this.reviewContract());
        this.el.prev.addEventListener('click', () => this.queuePage(this.pageNum - 1));
        this.el.next.addEventListener('click', () => this.queuePage(this.pageNum + 1));
        this.el.back.addEventListener('click', () => this.close());
        this.el.historyRefresh.addEventListener('click', () => this.loadHistory());
        this.el.followupSend?.addEventListener('click', () => this.askFollowup());
        this.el.perspective?.addEventListener('change', () => this.handlePerspectiveChange());
        this.el.followupInput?.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.askFollowup();
        });
    },

    open() {
        this.el.chat.classList.add('hidden');
        this.el.inputArea.classList.add('hidden');
        document.getElementById('user-admin-page')?.classList.add('hidden');
        document.getElementById('hall-workbench')?.classList.add('hidden');
        this.el.page.classList.remove('hidden');
        document.getElementById('current-scene').textContent = '📋 合同审查工作台';
        this.loadHistory().catch(() => {});
    },

    close() {
        this.el.page.classList.add('hidden');
        this.el.chat.classList.remove('hidden');
        this.el.inputArea.classList.remove('hidden');
        document.getElementById('current-scene').textContent = App.scenes[App.currentScene]?.name || '💬 法律问答';
        document.getElementById('chat-input').focus();
    },

    async handleFile() {
        const file = this.el.fileInput.files?.[0];
        if (!file) return;
        if (file.size > 30 * 1024 * 1024) {
            alert('文件超过 30MB，建议压缩后上传');
            return;
        }
        this.file = file;
        this.filePayload = null;
        this.review = null;
        this.sortedIssues = [];
        this.currentParsedDoc = null;
        this.currentDocumentId = '';
        this.parties = [];
        this.isParsing = false;
        this.followups = [];
        this.currentRecord = null;
        this.el.fileName.textContent = file.name;
        this.el.summary.classList.add('hidden');
        this.el.issues.innerHTML = '';
        this.renderParties([], '正在等待解析...');
        this.hideFollowupPanel();
        this.el.status.classList.add('hidden');
        this.hideJobProgress();
        this.stopJobProgressTicker();
        this.el.highlight.classList.add('hidden');
        this.el.renderedDoc.classList.add('hidden');
        this.el.renderedDoc.innerHTML = '';

        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            await this.loadPdfPreview(file);
        } else {
            this.pdfDoc = null;
            this.el.canvas.classList.add('hidden');
            this.el.renderedDoc.classList.add('hidden');
            this.el.empty.classList.remove('hidden');
            if (file.name.toLowerCase().endsWith('.docx')) {
                this.el.empty.textContent = '正在解析，稍后将在这里展示 MinerU 解析版 Word 原文';
                this.el.pageInfo.textContent = 'Word 解析预览';
            } else {
                this.el.empty.textContent = '正在解析，稍后将在这里展示解析后的合同文本';
                this.el.pageInfo.textContent = '文本解析预览';
            }
        }
        this.parseUploadedContract().catch(() => {});
    },

    async parseUploadedContract() {
        if (!this.file) return;
        const parsingFile = this.file;
        this.isParsing = true;
        this.el.reviewBtn.disabled = true;
        this.setStatus('正在解析合同并识别主体...');
        this.renderParties([], '解析中...');
        try {
            const payload = await this.fileToPayload();
            const data = await API.parseContract(payload, this.el.contractType?.value || 'general');
            if (this.file !== parsingFile) return;
            this.currentDocumentId = data.document_id || data.document?.id || '';
            this.currentParsedDoc = data.parsed_doc || data.document?.parsed_doc || null;
            this.parties = data.parties || data.document?.parties || [];
            if (this.currentParsedDoc?.markdown) {
                this.renderParsedDocument(this.currentParsedDoc, { allowFollowup: false });
            }
            this.renderParties(this.parties, this.parties.length ? '请选择我方立场' : '未识别到主体，可自定义');
            this.setStatus('解析完成，请选择审查设置后开始审查');
        } catch (e) {
            if (this.file !== parsingFile) return;
            this.currentDocumentId = '';
            this.currentParsedDoc = null;
            this.parties = [];
            this.renderParties([], '解析失败，可直接审查');
            this.setStatus(e.message || '解析失败，可点击开始审查重试');
        } finally {
            if (this.file === parsingFile) {
                this.isParsing = false;
                this.el.reviewBtn.disabled = false;
            }
        }
    },

    async loadPdfPreview(file) {
        if (!window.pdfjsLib) {
            this.el.empty.textContent = 'PDF 预览组件加载中，请稍后重试';
            return;
        }
        const bytes = await file.arrayBuffer();
        this.pdfDoc = await window.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
        this.pageNum = 1;
        this.el.canvas.classList.remove('hidden');
        this.el.empty.classList.add('hidden');
        await this.renderPage(1);
    },

    async renderPage(num) {
        if (!this.pdfDoc || num < 1 || num > this.pdfDoc.numPages) return;
        this.pageRendering = true;
        const page = await this.pdfDoc.getPage(num);
        const stageWidth = document.getElementById('pdf-stage').clientWidth - 28;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(stageWidth / baseViewport.width, 1.6);
        const viewport = page.getViewport({ scale });
        const canvas = this.el.canvas;
        const ctx = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;
        this.pageNum = num;
        this.el.pageInfo.textContent = `第 ${num} / ${this.pdfDoc.numPages} 页`;
        this.pageRendering = false;
        if (this.pendingPage) {
            const next = this.pendingPage;
            this.pendingPage = null;
            await this.renderPage(next);
        }
    },

    queuePage(num) {
        if (!this.pdfDoc || num < 1 || num > this.pdfDoc.numPages) return;
        this.flashPageHighlight();
        if (this.pageRendering) {
            this.pendingPage = num;
        } else {
            this.renderPage(num);
        }
    },

    async fileToPayload() {
        if (this.filePayload) return this.filePayload;
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(this.file);
        });
        this.filePayload = {
            name: this.file.name,
            mime_type: dataUrl.substring(5, dataUrl.indexOf(';')),
            data: dataUrl.substring(dataUrl.indexOf(',') + 1),
        };
        return this.filePayload;
    },

    async reviewContract() {
        if (!this.file) {
            alert('请先上传合同文件');
            return;
        }
        if (this.isParsing) {
            alert('合同仍在解析中，请稍后再开始审查');
            return;
        }
        this.el.reviewBtn.disabled = true;
        this.setStatus(this.currentDocumentId ? '正在基于解析结果生成风险点...' : '正在解析合同并生成风险点...');
        this.showJobProgress({ status: 'queued', stage: 'queued', progress: 3, message: this.currentDocumentId ? '任务已提交，等待开始审查...' : '任务已提交，等待开始解析...' });
        this.startJobProgressTicker();
        this.el.issues.innerHTML = '';
        this.el.summary.classList.add('hidden');
        try {
            const payload = await this.fileToPayload();
            const result = await API.reviewContract(
                payload,
                this.el.note.value.trim(),
                this.el.contractType?.value || 'general',
                this.el.referenceEnabled?.checked || false,
                this.el.issueLimit?.value || '12',
                job => this.setReviewJobStatus(job),
                {
                    documentId: this.currentDocumentId,
                    reviewPerspective: this.getReviewPerspective(),
                    representedParty: this.getRepresentedParty(),
                }
            );
            this.review = result.review;
            this.currentRecord = result.record || null;
            this.currentDocumentId = result.record?.document_id || this.currentDocumentId;
            this.renderParsedDocument(result.parsed_doc);
            this.renderReview();
            this.setStatus('审查完成');
            this.showJobProgress({ status: 'done', stage: 'done', progress: 100, message: '审查完成' });
            this.stopJobProgressTicker();
            await this.loadHistory();
        } catch (e) {
            this.setStatus(e.message || '审查失败');
            this.showJobProgress({ status: 'failed', stage: 'failed', progress: 100, message: e.message || '审查失败' });
            this.stopJobProgressTicker();
        } finally {
            this.el.reviewBtn.disabled = false;
        }
    },

    renderReview() {
        const review = this.review || { issues: [] };
        const severityName = { high: '高风险', medium: '中风险', low: '低风险' };
        this.el.summary.classList.remove('hidden');
        const references = Array.isArray(review.references) ? review.references : [];
        this.el.summary.innerHTML = `
            <div class="summary-risk ${this.escape(review.overall_risk || 'medium')}">${severityName[review.overall_risk] || '中风险'}</div>
            <p>${this.escape(review.summary || '已完成合同审查。')}</p>
            ${references.length ? `
                <div class="review-references">
                    <strong>法规/案例依据</strong>
                    ${references.map(ref => `
                        <details>
                            <summary>${this.escape(ref.title || (ref.type === 'case' ? '相关案例' : '相关法规'))}</summary>
                            <pre>${this.escape(ref.content || '')}</pre>
                        </details>
                    `).join('')}
                </div>
            ` : ''}
        `;
        if (!review.issues.length) {
            this.sortedIssues = [];
            this.el.issues.innerHTML = '<div class="empty-issues">暂未识别到明显风险点</div>';
            return;
        }
        const severityRank = { high: 0, medium: 1, low: 2 };
        const sortedIssues = [...review.issues].sort((a, b) => {
            const rankA = severityRank[a.severity] ?? 3;
            const rankB = severityRank[b.severity] ?? 3;
            return rankA - rankB || Number(a.page || 1) - Number(b.page || 1);
        });
        this.sortedIssues = sortedIssues;
        this.el.issues.innerHTML = `
            <div class="issue-list-hint">风险已按等级排序，点击卡片可跳转到对应原文段落，也可直接复制卡片内容。</div>
            ${sortedIssues.map((issue, index) => `
            <div class="issue-card ${this.escape(issue.severity)}" id="contract-issue-${index}" data-index="${index}" data-page="${issue.page}" role="button" tabindex="0">
                <span class="issue-top">
                    <strong>${this.escape(issue.title)}</strong>
                    <em>${severityName[issue.severity] || '中风险'} · 第 ${issue.page} 页</em>
                </span>
                <button type="button" class="issue-copy-btn" data-index="${index}" title="复制风险点">复制</button>
                <span class="issue-category">${this.escape(issue.category)}</span>
                ${issue.quote ? `<span class="issue-quote">“${this.escape(issue.quote)}”</span>` : ''}
                <span class="issue-analysis">${this.escape(issue.analysis)}</span>
                ${issue.basis ? `<span class="issue-basis">依据：${this.escape(issue.basis)}</span>` : ''}
                <span class="issue-suggestion">${this.escape(issue.suggestion)}</span>
            </div>
        `).join('')}`;
        this.el.issues.querySelectorAll('.issue-card').forEach(card => {
            const focusIssue = () => {
                const page = Number(card.dataset.page || 1);
                const issue = sortedIssues[Number(card.dataset.index || 0)];
                if (!this.highlightQuote(issue?.quote || '')) {
                    this.queuePage(page);
                }
            };
            card.addEventListener('click', event => {
                if (event.target.closest('.issue-copy-btn')) return;
                if (window.getSelection?.().toString().trim()) return;
                focusIssue();
            });
            card.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                if (event.target.closest('.issue-copy-btn')) return;
                event.preventDefault();
                focusIssue();
            });
        });
        this.el.issues.querySelectorAll('.issue-copy-btn').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                const issue = sortedIssues[Number(btn.dataset.index || 0)];
                this.copyIssue(issue, btn, severityName);
            });
        });
        this.applyRiskHighlights(sortedIssues);
    },

    async copyIssue(issue, btn, severityName = { high: '高风险', medium: '中风险', low: '低风险' }) {
        if (!issue) return;
        const lines = [
            `风险等级：${severityName[issue.severity] || '中风险'}`,
            issue.page ? `页码：第 ${issue.page} 页` : '',
            issue.category ? `类别：${issue.category}` : '',
            issue.title ? `标题：${issue.title}` : '',
            issue.quote ? `原文：${issue.quote}` : '',
            issue.analysis ? `分析：${issue.analysis}` : '',
            issue.basis ? `依据：${issue.basis}` : '',
            issue.suggestion ? `建议：${issue.suggestion}` : '',
        ].filter(Boolean).join('\n');
        try {
            await this.copyText(lines);
            if (btn) {
                const oldText = btn.textContent;
                btn.textContent = '已复制';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = oldText;
                    btn.classList.remove('copied');
                }, 1200);
            }
        } catch (e) {
            alert('复制失败，请手动选中卡片文字复制');
        }
    },

    async copyText(text) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        if (!ok) throw new Error('copy failed');
    },

    renderParties(parties = [], status = '') {
        if (!this.el.partyPanel || !this.el.partyList) return;
        this.el.partyPanel.classList.remove('hidden');
        this.el.partyStatus.textContent = status || '';
        if (!parties.length) {
            this.el.partyList.innerHTML = '<div class="history-empty">暂未识别到明确主体</div>';
            if (this.el.perspective) {
                this.el.perspective.innerHTML = `
                    <option value="neutral">中立审查</option>
                    <option value="custom">自定义我方</option>
                `;
                this.el.perspective.value = 'neutral';
            }
            this.handlePerspectiveChange();
            return;
        }
        this.el.partyList.innerHTML = parties.map((party, index) => `
            <label class="party-option">
                <input type="radio" name="contract-party-choice" value="${index}">
                <span>
                    <strong>${this.escape(party.role || '合同主体')}：${this.escape(party.name || '未命名主体')}</strong>
                    ${party.aliases?.length ? `<span>别称：${party.aliases.map(alias => this.escape(alias)).join('、')}</span>` : ''}
                    ${party.source_quote ? `<small>${this.escape(party.source_quote)}</small>` : ''}
                </span>
            </label>
        `).join('');
        this.el.partyList.querySelectorAll('input[name="contract-party-choice"]').forEach(input => {
            input.addEventListener('change', () => {
                if (this.el.perspective) this.el.perspective.value = `party:${input.value}`;
                this.handlePerspectiveChange();
            });
        });
        if (this.el.perspective) {
            const current = this.el.perspective.value;
            this.el.perspective.innerHTML = `
                <option value="neutral">中立审查</option>
                ${parties.map((party, index) => `<option value="party:${index}">代表${this.escape(party.role || '主体')}${party.name ? ` · ${this.escape(party.name)}` : ''}</option>`).join('')}
                <option value="custom">自定义我方</option>
            `;
            this.el.perspective.value = current && [...this.el.perspective.options].some(opt => opt.value === current) ? current : 'neutral';
        }
        this.handlePerspectiveChange();
    },

    handlePerspectiveChange() {
        const value = this.el.perspective?.value || 'neutral';
        const isCustom = value === 'custom';
        this.el.customPartyField?.classList.toggle('hidden', !isCustom);
        const match = value.match(/^party:(\d+)$/);
        this.el.partyList?.querySelectorAll('input[name="contract-party-choice"]').forEach(input => {
            input.checked = match ? input.value === match[1] : false;
        });
    },

    getRepresentedParty() {
        const value = this.el.perspective?.value || 'neutral';
        if (value === 'neutral') return {};
        if (value === 'custom') {
            const raw = (this.el.customPartyInput?.value || '').trim();
            return raw ? { role: '自定义我方', name: raw } : {};
        }
        const match = value.match(/^party:(\d+)$/);
        if (!match) return {};
        return this.parties[Number(match[1])] || {};
    },

    getReviewPerspective() {
        const value = this.el.perspective?.value || 'neutral';
        return value === 'neutral' ? 'neutral' : 'represented_party';
    },

    renderParsedDocument(parsedDoc, options = {}) {
        if (!parsedDoc?.markdown) return;
        this.currentParsedDoc = parsedDoc;
        const docName = parsedDoc.document_type === 'word' ? 'Word' : parsedDoc.document_type === 'pdf' ? 'PDF' : '文档';
        const sourceLabel = parsedDoc.source === 'mineru'
            ? `MinerU 解析版${docName}${parsedDoc.asset_count ? ` · ${parsedDoc.asset_count} 个资源` : ''}`
            : `${docName} 解析降级版`;
        this.el.canvas.classList.add('hidden');
        this.el.empty.classList.add('hidden');
        this.el.renderedDoc.classList.remove('hidden');
        this.el.pageInfo.textContent = sourceLabel;
        this.el.renderedDoc.innerHTML = `
            <div class="rendered-doc-banner">
                <strong>${this.escape(sourceLabel)}</strong>
                ${parsedDoc.error ? `<span>${this.escape(parsedDoc.error)}</span>` : '<span>风险点会优先定位到解析后的原文段落。</span>'}
            </div>
            <div class="mineru-doc">${this.renderMarkdown(parsedDoc.markdown)}</div>
        `;
        this.applyRiskHighlights(this.sortedIssues);
        if (options.allowFollowup !== false) this.showFollowupPanel();
    },

    async loadHistory() {
        if (!this.el.historyList) return;
        this.el.historyList.innerHTML = '<div class="history-empty">加载中...</div>';
        try {
            const data = await API.listContractReviews();
            const reviews = data.reviews || [];
            if (!reviews.length) {
                this.el.historyList.innerHTML = '<div class="history-empty">暂无审查记录</div>';
                return;
            }
            const riskName = { high: '高', medium: '中', low: '低' };
            this.el.historyList.innerHTML = reviews.map(item => `
                <div class="history-item ${this.currentRecord?.id === item.id ? 'active' : ''}" data-id="${item.id}">
                    <button class="history-open" title="${this.escape(item.filename)}">
                        <strong>${this.escape(item.filename)}</strong>
                        <span>${this.formatTime(item.created_at)} · ${riskName[item.overall_risk] || '中'}风险 · ${item.issue_count}项</span>
                    </button>
                    <button class="history-delete" title="删除">×</button>
                </div>
            `).join('');
            this.el.historyList.querySelectorAll('.history-open').forEach(btn => {
                btn.addEventListener('click', () => this.openHistory(btn.closest('.history-item').dataset.id));
            });
            this.el.historyList.querySelectorAll('.history-delete').forEach(btn => {
                btn.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    const id = btn.closest('.history-item').dataset.id;
                    if (!confirm('确定删除这条审查记录吗？')) return;
                    await API.deleteContractReview(id);
                    if (this.currentRecord?.id === id) {
                        this.currentRecord = null;
                    }
                    await this.loadHistory();
                });
            });
        } catch (e) {
            this.el.historyList.innerHTML = `<div class="history-empty">${this.escape(e.message || '历史加载失败')}</div>`;
        }
    },

    async openHistory(reviewId) {
        this.setStatus('正在恢复审查记录...');
        const data = await API.getContractReview(reviewId);
        const record = data.review;
        this.currentRecord = record;
        this.review = record.review || { issues: [] };
        this.sortedIssues = [];
        this.currentParsedDoc = record.parsed_doc || null;
        this.currentDocumentId = record.document_id || '';
        this.parties = [];
        this.isParsing = false;
        this.followups = [];
        this.file = null;
        this.filePayload = null;
        this.pdfDoc = null;
        this.el.fileInput.value = '';
        this.el.fileName.textContent = record.filename || '历史审查记录';
        this.el.note.value = record.note || '';
        if (this.el.contractType) {
            this.el.contractType.value = record.contract_type || record.parsed_doc?.contract_type || 'general';
        }
        if (this.el.referenceEnabled) {
            this.el.referenceEnabled.checked = !!record.include_references || !!record.review?.references?.length;
        }
        this.renderParties([], record.review_perspective && record.review_perspective !== 'neutral' ? '历史记录：按指定立场审查' : '历史记录');
        if (record.review_perspective && record.review_perspective !== 'neutral' && this.el.perspective) {
            this.el.perspective.value = 'custom';
            if (this.el.customPartyInput) {
                const party = record.represented_party || record.review?.represented_party || {};
                this.el.customPartyInput.value = [party.role, party.name].filter(Boolean).join(' ');
            }
            this.handlePerspectiveChange();
        }
        this.el.canvas.classList.add('hidden');
        this.el.empty.classList.add('hidden');
        if (record.parsed_doc?.markdown) {
            this.renderParsedDocument(record.parsed_doc);
        } else {
            this.el.renderedDoc.classList.add('hidden');
            this.el.empty.classList.remove('hidden');
            this.el.empty.textContent = '该历史记录没有保存解析版文档';
            this.el.pageInfo.textContent = '历史审查记录';
        }
        this.renderReview();
        this.showFollowupPanel();
        this.setStatus('已恢复历史审查');
        setTimeout(() => this.el.status.classList.add('hidden'), 1200);
        await this.loadHistory();
    },

    formatTime(ts) {
        if (!ts) return '';
        const date = new Date(ts * 1000);
        return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' +
            date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },

    highlightQuote(quote) {
        if (this.el.renderedDoc.classList.contains('hidden') || !quote) return false;
        this.el.renderedDoc.querySelectorAll('.doc-risk-hit').forEach(el => el.classList.remove('doc-risk-hit'));
        const match = this.findBestQuoteNode(quote);
        if (!match) return false;
        match.node.classList.add('doc-risk-hit');
        match.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
    },

    applyRiskHighlights(issues) {
        if (this.el.renderedDoc.classList.contains('hidden') || !issues?.length) return;
        this.clearRiskHighlights();
        issues.forEach((issue, index) => {
            const quote = (issue.quote || '').trim();
            if (!quote) return;
            const match = this.findBestQuoteNode(quote);
            if (!match || match.node.querySelector('.doc-risk-mark')) return;
            if (!this.markExactText(match.node, quote, issue, index)) {
                match.node.classList.add('doc-risk-mark-block', issue.severity || 'medium');
                match.node.dataset.issueIndex = String(index);
                match.node.title = `${issue.title || '风险点'}：点击查看左侧风险卡片`;
                match.node.onclick = () => this.focusIssueCard(index);
            }
        });
    },

    getTextCandidates() {
        return [...this.el.renderedDoc.querySelectorAll('.mineru-doc p, .mineru-doc li, .mineru-doc td, .mineru-doc th, .mineru-doc blockquote, .mineru-doc h1, .mineru-doc h2, .mineru-doc h3')]
            .filter(node => this.normalizeText(node.textContent).length >= 6);
    },

    getQuoteFragments(quote) {
        const normalized = this.normalizeText(quote);
        if (!normalized) return [];
        const fragments = new Set();
        if (normalized.length <= 90) {
            fragments.add(normalized);
        } else {
            fragments.add(normalized.slice(0, 90));
            fragments.add(normalized.slice(-90));
        }
        const rawParts = (quote || '')
            .split(/[，。；;、：:\n\r（）()《》“”"'\s]+/)
            .map(part => this.normalizeText(part))
            .filter(part => part.length >= 8 && part.length <= 90);
        rawParts.slice(0, 8).forEach(part => fragments.add(part));
        for (let start = 0; start < normalized.length; start += 24) {
            const piece = normalized.slice(start, start + 36);
            if (piece.length >= 16) fragments.add(piece);
        }
        return [...fragments];
    },

    findBestQuoteNode(quote) {
        const fragments = this.getQuoteFragments(quote);
        if (!fragments.length) return null;
        const candidates = this.getTextCandidates();
        let best = null;
        for (const node of candidates) {
            const text = this.normalizeText(node.textContent);
            if (!text) continue;
            let score = 0;
            for (const fragment of fragments) {
                if (text.includes(fragment)) {
                    score += Math.min(80, fragment.length);
                } else if (fragment.includes(text.slice(0, Math.min(50, text.length)))) {
                    score += 12;
                }
            }
            if (score > 0 && (!best || score > best.score)) {
                best = { node, score };
            }
        }
        return best && best.score >= 16 ? best : null;
    },

    clearRiskHighlights() {
        this.el.renderedDoc.querySelectorAll('.doc-risk-mark').forEach(mark => {
            mark.replaceWith(document.createTextNode(mark.textContent || ''));
        });
        this.el.renderedDoc.querySelectorAll('.doc-risk-mark-block').forEach(node => {
            node.classList.remove('doc-risk-mark-block', 'high', 'medium', 'low');
            delete node.dataset.issueIndex;
            node.removeAttribute('title');
            node.onclick = null;
        });
    },

    markExactText(container, quote, issue, index) {
        const shortQuote = quote.replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!shortQuote) return false;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) {
            textNodes.push(walker.currentNode);
        }
        for (const textNode of textNodes) {
            const raw = textNode.nodeValue || '';
            const exactIndex = raw.indexOf(shortQuote);
            if (exactIndex < 0) continue;
            const range = document.createRange();
            range.setStart(textNode, exactIndex);
            range.setEnd(textNode, exactIndex + shortQuote.length);
            const mark = document.createElement('mark');
            mark.className = `doc-risk-mark ${issue.severity || 'medium'}`;
            mark.dataset.issueIndex = String(index);
            mark.title = `${issue.title || '风险点'}：点击查看左侧风险卡片`;
            mark.addEventListener('click', event => {
                event.stopPropagation();
                this.focusIssueCard(index);
            });
            range.surroundContents(mark);
            return true;
        }
        return false;
    },

    focusIssueCard(index) {
        const card = this.el.issues.querySelector(`.issue-card[data-index="${index}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('doc-risk-hit');
        void card.offsetWidth;
        card.classList.add('doc-risk-hit');
        setTimeout(() => card.classList.remove('doc-risk-hit'), 1600);
    },

    showFollowupPanel() {
        if (!this.el.followupPanel) return;
        if (!this.currentParsedDoc?.markdown || !this.review) return;
        this.el.followupPanel.classList.remove('hidden');
        this.renderFollowups();
    },

    hideFollowupPanel() {
        if (!this.el.followupPanel) return;
        this.el.followupPanel.classList.add('hidden');
        this.el.followupList.innerHTML = '';
        if (this.el.followupInput) this.el.followupInput.value = '';
    },

    renderFollowups() {
        if (!this.el.followupList) return;
        if (!this.followups.length) {
            this.el.followupList.innerHTML = '<div class="history-empty">审查完成后，可以继续围绕当前合同追问。</div>';
            return;
        }
        this.el.followupList.innerHTML = this.followups.map(item => `
            <div class="followup-item ${this.escape(item.role)}">${this.renderMarkdown(item.content || '')}</div>
        `).join('');
        this.el.followupList.scrollTop = this.el.followupList.scrollHeight;
    },

    async askFollowup() {
        const question = (this.el.followupInput?.value || '').trim();
        if (!question) return;
        if (!this.currentParsedDoc?.markdown || !this.review) {
            alert('请先完成一次合同审查');
            return;
        }
        this.followups.push({ role: 'user', content: question });
        this.followups.push({ role: 'assistant', content: '正在分析当前合同...' });
        this.renderFollowups();
        this.el.followupInput.value = '';
        this.el.followupSend.disabled = true;
        try {
            const data = await API.askContractFollowup(
                question,
                this.currentParsedDoc,
                this.review,
                this.el.contractType?.value || this.currentParsedDoc.contract_type || 'general',
                this.el.referenceEnabled?.checked || false
            );
            this.followups[this.followups.length - 1] = { role: 'assistant', content: data.answer || '未生成回答。' };
        } catch (e) {
            this.followups[this.followups.length - 1] = { role: 'assistant', content: e.message || '追问失败' };
        } finally {
            this.el.followupSend.disabled = false;
            this.renderFollowups();
        }
    },

    normalizeText(text) {
        return (text || '').replace(/\s+/g, '').replace(/[“”"']/g, '').trim();
    },

    renderMarkdown(text) {
        if (typeof marked === 'undefined') {
            return this.escape(text).replace(/\n/g, '<br>');
        }
        try {
            return marked.parse(text || '', { breaks: true, gfm: true });
        } catch (e) {
            return this.escape(text).replace(/\n/g, '<br>');
        }
    },

    flashPageHighlight() {
        this.el.highlight.classList.remove('hidden');
        this.el.highlight.classList.remove('pulse');
        void this.el.highlight.offsetWidth;
        this.el.highlight.classList.add('pulse');
        setTimeout(() => this.el.highlight.classList.add('hidden'), 1600);
    },

    setStatus(text) {
        this.el.status.textContent = text;
        this.el.status.classList.remove('hidden');
    },

    setReviewJobStatus(job) {
        if (!job) return;
        const progress = Number(job.progress || 0);
        const message = job.message || '正在处理审查任务...';
        this.showJobProgress(job);
        this.setStatus(progress ? `${progress}% · ${message}` : message);
    },

    showJobProgress(job) {
        if (!this.el.jobProgress) return;
        this.jobProgressState = { ...(this.jobProgressState || {}), ...job, receivedAt: Date.now() };
        this.optimisticProgress = Math.max(this.optimisticProgress || 0, Number(job.progress || 0));
        this.renderJobProgress({
            ...this.jobProgressState,
            progress: ['done', 'failed'].includes(this.jobProgressState.status)
                ? Number(this.jobProgressState.progress || 0)
                : Math.max(Number(this.jobProgressState.progress || 0), this.optimisticProgress),
        });
    },

    renderJobProgress(job) {
        if (!this.el.jobProgress || !job) return;
        const stageOrder = ['queued', 'parsing', 'referencing', 'reviewing', 'saving', 'done'];
        const currentStage = job.stage || 'queued';
        const currentIndex = currentStage === 'failed' ? stageOrder.length - 1 : Math.max(0, stageOrder.indexOf(currentStage));
        const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));

        this.el.jobProgress.classList.remove('hidden', 'failed');
        if (job.status === 'failed' || currentStage === 'failed') {
            this.el.jobProgress.classList.add('failed');
        }
        this.el.jobTitle.textContent = job.filename ? `审查任务 · ${job.filename}` : '审查任务';
        this.el.jobPercent.textContent = `${progress}%`;
        this.el.jobBar.style.width = `${progress}%`;
        this.el.jobMessage.textContent = job.message || '正在处理审查任务...';

        this.el.jobProgress.querySelectorAll('[data-stage]').forEach(step => {
            const stepStage = step.dataset.stage;
            const stepIndex = stageOrder.indexOf(stepStage);
            step.classList.remove('active', 'done');
            if (job.status === 'failed') {
                if (stepIndex < currentIndex) step.classList.add('done');
                if (stepIndex === currentIndex) step.classList.add('active');
                return;
            }
            if (stepIndex < currentIndex || currentStage === 'done') {
                step.classList.add('done');
            } else if (stepIndex === currentIndex) {
                step.classList.add('active');
            }
        });
    },

    startJobProgressTicker() {
        this.stopJobProgressTicker();
        this.jobProgressStartedAt = Date.now();
        this.optimisticProgress = Math.max(this.optimisticProgress || 0, 3);
        this.jobProgressTimer = setInterval(() => this.tickJobProgress(), 1000);
    },

    stopJobProgressTicker() {
        if (this.jobProgressTimer) {
            clearInterval(this.jobProgressTimer);
            this.jobProgressTimer = null;
        }
    },

    tickJobProgress() {
        if (!this.jobProgressState || ['done', 'failed'].includes(this.jobProgressState.status)) return;
        let stage = this.jobProgressState.stage || 'queued';
        let message = this.jobProgressState.message || '正在处理审查任务...';

        const caps = { queued: 12, parsing: 58, referencing: 70, reviewing: 88, saving: 96 };
        const cap = caps[stage] ?? 96;
        const realProgress = Number(this.jobProgressState.progress || 0);
        this.optimisticProgress = Math.max(this.optimisticProgress || 0, realProgress);
        if (this.optimisticProgress < cap) {
            const step = stage === 'reviewing' ? 2 : 1;
            this.optimisticProgress = Math.min(cap, this.optimisticProgress + step);
        }

        this.renderJobProgress({
            ...this.jobProgressState,
            stage,
            message,
            progress: Math.max(realProgress, this.optimisticProgress),
        });
    },

    hideJobProgress() {
        if (!this.el.jobProgress) return;
        this.el.jobProgress.classList.add('hidden');
        this.el.jobProgress.classList.remove('failed');
        this.el.jobBar.style.width = '0%';
        this.el.jobPercent.textContent = '0%';
        this.el.jobMessage.textContent = '等待开始...';
        this.jobProgressState = null;
        this.jobProgressStartedAt = 0;
        this.optimisticProgress = 0;
        this.el.jobProgress.querySelectorAll('[data-stage]').forEach(step => {
            step.classList.remove('active', 'done');
        });
    },

    escape(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    },
};
