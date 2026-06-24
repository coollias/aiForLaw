const HallucinationWorkbench = {
    result: null,
    pages: [],
    currentPageIndex: 0,

    init() {
        this.el = {
            page: document.getElementById('hall-workbench'),
            chat: document.getElementById('chat-area'),
            inputArea: document.querySelector('.input-area'),
            back: document.getElementById('hall-back-btn'),
            input: document.getElementById('hall-text-input'),
            fileInput: document.getElementById('hall-file-input'),
            fileName: document.getElementById('hall-file-name'),
            count: document.getElementById('hall-text-count'),
            clear: document.getElementById('hall-clear-btn'),
            check: document.getElementById('hall-check-btn'),
            status: document.getElementById('hall-status'),
            empty: document.getElementById('hall-empty-result'),
            content: document.getElementById('hall-result-content'),
            regCount: document.getElementById('hall-reg-count'),
            caseCount: document.getElementById('hall-case-count'),
            riskCount: document.getElementById('hall-risk-count'),
            regNote: document.getElementById('hall-reg-note'),
            caseNote: document.getElementById('hall-case-note'),
            regList: document.getElementById('hall-reg-list'),
            caseList: document.getElementById('hall-case-list'),
            highlighted: document.getElementById('hall-highlighted-text'),
            raw: document.getElementById('hall-raw-json'),
            pageTitle: document.getElementById('hall-page-title'),
            pageSubtitle: document.getElementById('hall-page-subtitle'),
            pageIndicator: document.getElementById('hall-page-indicator'),
            pageText: document.getElementById('hall-page-text'),
            pageResultNote: document.getElementById('hall-page-result-note'),
            pageResultList: document.getElementById('hall-page-result-list'),
            prevPage: document.getElementById('hall-prev-page'),
            nextPage: document.getElementById('hall-next-page'),
            tabs: document.querySelectorAll('.hall-tab'),
            panels: {
                pages: document.getElementById('hall-tab-pages'),
                overview: document.getElementById('hall-tab-overview'),
                highlight: document.getElementById('hall-tab-highlight'),
                raw: document.getElementById('hall-tab-raw'),
            },
        };
        if (!this.el.page) return;

        this.el.back.addEventListener('click', () => this.close());
        this.el.clear.addEventListener('click', () => this.clear());
        this.el.check.addEventListener('click', () => this.check());
        this.el.fileInput.addEventListener('change', () => this.handleFile());
        this.el.input.addEventListener('input', () => this.updateCount());
        this.el.input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.check();
        });
        this.el.prevPage.addEventListener('click', () => this.changePage(-1));
        this.el.nextPage.addEventListener('click', () => this.changePage(1));
        this.el.tabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.hallTab));
        });
        this.updateCount();
    },

    open() {
        this.el.chat.classList.add('hidden');
        this.el.inputArea.classList.add('hidden');
        document.getElementById('contract-workbench')?.classList.add('hidden');
        document.getElementById('user-admin-page')?.classList.add('hidden');
        this.el.page.classList.remove('hidden');
        document.getElementById('current-scene').textContent = '✓ 法律幻觉校验';
        this.el.input.focus();
    },

    close() {
        this.el.page.classList.add('hidden');
        this.el.chat.classList.remove('hidden');
        this.el.inputArea.classList.remove('hidden');
        document.getElementById('current-scene').textContent = App.scenes[App.currentScene]?.name || '💬 法律问答';
        document.getElementById('chat-input').focus();
    },

    clear() {
        this.el.input.value = '';
        this.el.fileInput.value = '';
        this.el.fileName.textContent = '可直接从文件提取文本到输入框';
        this.result = null;
        this.updateCount();
        this.setStatus('', true);
        this.el.content.classList.add('hidden');
        this.el.empty.classList.remove('hidden');
        this.pages = [];
        this.currentPageIndex = 0;
        this.el.input.focus();
    },

    async handleFile() {
        const file = this.el.fileInput.files?.[0];
        if (!file) return;
        if (file.size > 30 * 1024 * 1024) {
            this.setStatus('文件超过 30MB，请压缩后再上传');
            this.el.fileInput.value = '';
            return;
        }

        this.el.fileName.textContent = `正在解析：${file.name}`;
        this.setStatus('正在从文件中提取文本...');

        try {
            const payload = await this.fileToPayload(file);
            const result = await API.extractHallucinationFile(payload);
            this.el.input.value = result.text || '';
            this.updateCount();
            this.el.fileName.textContent = result.truncated
                ? `${file.name}（已提取前 ${result.char_count} 字）`
                : `${file.name}（已提取 ${result.char_count} 字）`;
            this.setStatus(result.truncated ? '文件文本较长，已截取前 5 万字用于校验' : '文件文本已提取，可以开始校验');
        } catch (e) {
            this.el.fileName.textContent = file.name;
            this.setStatus(e.message || '文件解析失败');
        }
    },

    async fileToPayload(file) {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        return {
            name: file.name,
            mime_type: dataUrl.substring(5, dataUrl.indexOf(';')) || file.type || '',
            data: dataUrl.substring(dataUrl.indexOf(',') + 1),
        };
    },

    updateCount() {
        const length = this.el.input.value.trim().length;
        this.el.count.textContent = `${length} 字`;
    },

    async check() {
        const text = this.el.input.value.trim();
        if (!text) {
            this.setStatus('请先粘贴需要校验的文本');
            return;
        }

        this.el.check.disabled = true;
        this.setStatus('正在调用元典法律幻觉校验接口...');
        this.switchTab('pages');

        try {
            const data = await API.checkHallucination(text);
            this.result = data.result || {};
            this.renderResult(data);
            this.setStatus(`校验完成，request_id: ${this.escape(data.request_id || this.result.request_id || '')}`);
        } catch (e) {
            this.setStatus(e.message || '校验失败');
        } finally {
            this.el.check.disabled = false;
        }
    },

    renderResult(wrapper) {
        const result = wrapper.result || {};
        const regulations = Array.isArray(result.regulations) ? result.regulations : [];
        const cases = Array.isArray(result.cases) ? result.cases : [];
        const riskCount = this.countRisks(regulations, cases);

        this.el.empty.classList.add('hidden');
        this.el.content.classList.remove('hidden');
        this.el.regCount.textContent = String(regulations.length);
        this.el.caseCount.textContent = String(cases.length);
        this.el.riskCount.textContent = String(riskCount);
        this.el.regNote.textContent = regulations.length ? '按接口返回顺序展示' : '未抽取到法规/法条';
        this.el.caseNote.textContent = cases.length ? '按接口返回顺序展示' : '未抽取到案例/案号';
        this.el.regList.innerHTML = regulations.length
            ? regulations.map(item => this.renderRegulation(item)).join('')
            : '<div class="hall-empty-list">未识别到明确的法规或法条引用。</div>';
        this.el.caseList.innerHTML = cases.length
            ? cases.map(item => this.renderCase(item)).join('')
            : '<div class="hall-empty-list">未识别到明确的案例或案号引用。</div>';
        this.el.highlighted.innerHTML = this.sanitizeHighlighted(result.highlighted_text || this.el.input.value);
        this.el.raw.textContent = JSON.stringify(result, null, 2);
        this.pages = this.buildPages(this.el.input.value, regulations, cases);
        this.currentPageIndex = 0;
        this.renderCurrentPage();
        this.switchTab('pages');
    },

    renderRegulation(item) {
        const semantic = item.semantic_compare || {};
        const conclusion = semantic['结论'] || (item.think_tank_clause_missing ? '未命中' : '待复核');
        const statusClass = this.statusClass(conclusion);
        const meta = [
            item.validity_status,
            item.publish_date ? `发布：${item.publish_date}` : '',
            item.implement_date ? `实施：${item.implement_date}` : '',
            item.document_number,
        ].filter(Boolean).join(' · ');

        return `
            <article class="hall-card">
                <div class="hall-card-head">
                    <div>
                        <strong>${this.escape(item.name || '未命名法规')}</strong>
                        <span>${this.escape(item.clause || (item.source_no_specific_clause ? '未指定条号' : ''))}</span>
                    </div>
                    <mark class="${statusClass}">${this.escape(conclusion)}</mark>
                </div>
                ${meta ? `<p class="hall-meta">${this.escape(meta)}</p>` : ''}
                ${item.content ? `<p class="hall-quote">${this.escape(item.content)}</p>` : ''}
                ${semantic['说明'] ? `<p class="hall-note">${this.escape(semantic['说明'])}</p>` : ''}
                ${item.think_tank_content ? `<details><summary>权威条文原文</summary><pre>${this.escape(item.think_tank_content)}</pre></details>` : ''}
                ${item.url ? `<a href="${this.escapeAttr(item.url)}" target="_blank" rel="noopener">查看来源</a>` : ''}
            </article>
        `;
    },

    renderCase(item) {
        const hit = !!(item.url || item.think_tank_content);
        const title = item.name || item.case_number || item['案号'] || '未命名案例';
        const meta = [
            item.case_number || item['案号'],
            item.court || item['法院'],
            item.judgment_date || item['日期'],
            item.case_type || item['案例类型'],
        ].filter(Boolean).join(' · ');

        return `
            <article class="hall-card">
                <div class="hall-card-head">
                    <div>
                        <strong>${this.escape(title)}</strong>
                        <span>${this.escape(meta)}</span>
                    </div>
                    <mark class="${hit ? 'ok' : 'warn'}">${hit ? '已命中' : '需复核'}</mark>
                </div>
                ${item.content ? `<p class="hall-quote">${this.escape(item.content)}</p>` : ''}
                ${item.think_tank_content ? `<details><summary>权威来源内容</summary><pre>${this.escape(item.think_tank_content)}</pre></details>` : ''}
                ${item.url ? `<a href="${this.escapeAttr(item.url)}" target="_blank" rel="noopener">查看来源</a>` : ''}
            </article>
        `;
    },

    buildPages(sourceText, regulations, cases) {
        const refs = [
            ...regulations.map(item => ({ type: 'regulation', item, snippet: item.content || `${item.name || ''}${item.clause || ''}`.trim() })),
            ...cases.map(item => ({ type: 'case', item, snippet: item.content || item.case_number || item['案号'] || item.name || '' })),
        ].filter(ref => ref.snippet);

        if (!refs.length) {
            return [{
                title: '全文卡片',
                subtitle: '未抽取到明确引用，展示原文',
                text: sourceText,
                refs: [],
            }];
        }

        return this.uniqueRefs(refs).map((ref, index) => {
            const pos = sourceText.indexOf(ref.snippet);
            if (pos < 0) {
                const approxStart = Math.min(sourceText.length, index * 900);
                const start = Math.max(0, approxStart - 160);
                const end = Math.min(sourceText.length, approxStart + 1200);
                return {
                    title: `第 ${index + 1} 张卡片`,
                    subtitle: ref.type === 'case' ? '案例/案号引用' : '法规/法条引用',
                    start,
                    end,
                    text: sourceText.slice(start, end),
                    refs: [ref],
                    hasLeadingEllipsis: start > 0,
                    hasTrailingEllipsis: end < sourceText.length,
                };
            }
            const start = Math.max(0, pos - 160);
            const end = Math.min(sourceText.length, pos + ref.snippet.length + 180);
            return {
                title: `第 ${index + 1} 张卡片`,
                subtitle: ref.type === 'case' ? '案例/案号引用' : '法规/法条引用',
                start,
                end,
                text: sourceText.slice(start, end),
                refs: [ref],
                hasLeadingEllipsis: start > 0,
                hasTrailingEllipsis: end < sourceText.length,
            };
        });
    },

    uniqueRefs(refs) {
        const seen = new Set();
        return refs.filter(ref => {
            const key = `${ref.type}:${ref.item.extract_reg_id || ref.item.case_number || ref.item['案号'] || ref.snippet}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    },

    renderCurrentPage() {
        const page = this.pages[this.currentPageIndex] || {
            title: '第 1 张卡片',
            subtitle: '暂无校验结果',
            text: this.el.input.value,
            refs: [],
        };
        const total = Math.max(this.pages.length, 1);
        this.el.pageTitle.textContent = page.title;
        this.el.pageSubtitle.textContent = page.subtitle;
        this.el.pageIndicator.textContent = `${this.currentPageIndex + 1} / ${total}`;
        this.el.prevPage.disabled = this.currentPageIndex <= 0;
        this.el.nextPage.disabled = this.currentPageIndex >= total - 1;
        this.el.pageText.innerHTML = this.renderPageText(page);
        this.el.pageResultNote.textContent = page.refs.length ? '1 条' : '未识别到引用';
        this.el.pageResultList.innerHTML = page.refs.length
            ? page.refs.map(ref => ref.type === 'regulation' ? this.renderRegulation(ref.item) : this.renderCase(ref.item)).join('')
            : '<div class="hall-empty-list">当前卡片未识别到需要校验的法规、法条或案号。</div>';
    },

    renderPageText(page) {
        const refs = [...page.refs].sort((a, b) => (b.snippet || '').length - (a.snippet || '').length);
        let text = `${page.hasLeadingEllipsis ? '……\n' : ''}${page.text || ''}${page.hasTrailingEllipsis ? '\n……' : ''}`;
        const highlights = [];
        refs.forEach(ref => {
            const snippet = ref.snippet || '';
            const pos = text.indexOf(snippet);
            if (pos < 0) return;
            const end = pos + snippet.length;
            if (highlights.some(item => pos < item.end && end > item.start)) return;
            highlights.push({ start: pos, end, type: ref.type });
        });
        highlights.sort((a, b) => a.start - b.start);

        let html = '';
        let cursor = 0;
        highlights.forEach(item => {
            html += this.escape(text.slice(cursor, item.start));
            const cls = item.type === 'case' ? 'hl-case-ref' : 'hl-statute-link';
            html += `<span class="${cls}">${this.escape(text.slice(item.start, item.end))}</span>`;
            cursor = item.end;
        });
        html += this.escape(text.slice(cursor));
        return html;
    },

    changePage(delta) {
        const next = this.currentPageIndex + delta;
        if (next < 0 || next >= this.pages.length) return;
        this.currentPageIndex = next;
        this.renderCurrentPage();
    },

    countRisks(regulations, cases) {
        const regRisks = regulations.filter(item => {
            const semantic = item.semantic_compare || {};
            const conclusion = String(semantic['结论'] || '');
            if (item.think_tank_clause_missing || item.law_exists === false) return true;
            if (semantic.skipped || item.source_no_specific_clause) return true;
            return conclusion && !/一致|相符|命中/.test(conclusion);
        }).length;
        const caseRisks = cases.filter(item => !(item.url || item.think_tank_content)).length;
        return regRisks + caseRisks;
    },

    statusClass(value) {
        const text = String(value || '');
        if (/一致|相符|命中/.test(text) && !/不一致|未命中/.test(text)) return 'ok';
        if (/不一致|未命中|不存在|缺失/.test(text)) return 'bad';
        return 'warn';
    },

    switchTab(name) {
        this.el.tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.hallTab === name));
        Object.entries(this.el.panels).forEach(([key, panel]) => {
            panel.classList.toggle('hidden', key !== name);
        });
    },

    setStatus(message, hide = false) {
        if (hide || !message) {
            this.el.status.classList.add('hidden');
            this.el.status.textContent = '';
            return;
        }
        this.el.status.classList.remove('hidden');
        this.el.status.textContent = message;
    },

    sanitizeHighlighted(html) {
        const template = document.createElement('template');
        template.innerHTML = html || '';

        const walk = node => {
            if (node.nodeType === Node.TEXT_NODE) return this.escape(node.textContent || '');
            if (node.nodeType !== Node.ELEMENT_NODE) return '';
            const children = Array.from(node.childNodes).map(walk).join('');
            if (node.tagName.toLowerCase() !== 'span') return children;
            const safeClass = String(node.getAttribute('class') || '')
                .split(/\s+/)
                .filter(cls => /^[-_a-zA-Z0-9]+$/.test(cls))
                .join(' ');
            const title = node.getAttribute('title') || '';
            return `<span${safeClass ? ` class="${this.escapeAttr(safeClass)}"` : ''}${title ? ` title="${this.escapeAttr(title)}"` : ''}>${children}</span>`;
        };

        return Array.from(template.content.childNodes).map(walk).join('');
    },

    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    },

    escapeAttr(value) {
        return this.escape(value).replace(/`/g, '&#96;');
    },
};
