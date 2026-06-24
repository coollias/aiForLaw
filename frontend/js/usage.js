const UsagePage = {
    init() {
        this.el = {
            auth: document.getElementById('usage-auth'),
            content: document.getElementById('usage-content'),
            username: document.getElementById('usage-username'),
            password: document.getElementById('usage-password'),
            login: document.getElementById('usage-login-btn'),
            loginError: document.getElementById('usage-login-error'),
            range: document.getElementById('usage-range'),
            refresh: document.getElementById('usage-refresh-btn'),
            totalRequests: document.getElementById('usage-total-requests'),
            totalTokens: document.getElementById('usage-total-tokens'),
            promptTokens: document.getElementById('usage-prompt-tokens'),
            completionTokens: document.getElementById('usage-completion-tokens'),
            cost: document.getElementById('usage-cost'),
            trendChart: document.getElementById('usage-trend-chart'),
            featureChart: document.getElementById('usage-feature-chart'),
            pricingList: document.getElementById('usage-pricing-list'),
            pricingSource: document.getElementById('usage-pricing-source'),
            userRows: document.getElementById('usage-user-rows'),
            featureRows: document.getElementById('usage-feature-rows'),
            logRows: document.getElementById('usage-log-rows'),
        };
        this.el.login.addEventListener('click', () => this.login());
        this.el.password.addEventListener('keydown', event => {
            if (event.key === 'Enter') this.login();
        });
        this.el.username.addEventListener('keydown', event => {
            if (event.key === 'Enter') this.login();
        });
        this.el.refresh.addEventListener('click', () => this.load());
        this.el.range.addEventListener('change', () => this.load());
        this.load();
    },

    async load() {
        const days = this.el.range.value || '30';
        this.el.refresh.disabled = true;
        try {
            const auth = await API.checkAuth();
            if (!auth.authenticated || !auth.user?.is_admin) {
                this.showAuth();
                return;
            }
            const [summary, logs] = await Promise.all([
                API.get(`/api/admin/usage/summary?days=${encodeURIComponent(days)}`),
                API.get(`/api/admin/usage/logs?days=${encodeURIComponent(days)}&limit=100`),
            ]);
            this.render(summary, logs.logs || []);
            this.el.auth.classList.add('hidden');
            this.el.content.classList.remove('hidden');
        } catch (e) {
            this.showAuth();
        } finally {
            this.el.refresh.disabled = false;
        }
    },

    showAuth() {
        this.el.content.classList.add('hidden');
        this.el.auth.classList.remove('hidden');
        setTimeout(() => this.el.password.focus(), 0);
    },

    async login() {
        const username = this.el.username.value.trim() || 'admin';
        const password = this.el.password.value.trim();
        if (!password) {
            this.setLoginError('请输入密码');
            this.el.password.focus();
            return;
        }
        this.el.login.disabled = true;
        this.el.login.textContent = '登录中...';
        this.el.loginError.classList.add('hidden');
        try {
            const result = await API.login(username, password);
            if (!result.user?.is_admin) {
                await API.logout().catch(() => {});
                this.setLoginError('该账号不是管理员，不能查看用量统计');
                return;
            }
            const next = new URLSearchParams(location.search).get('next');
            if (next && next.startsWith('/')) {
                location.href = next;
                return;
            }
            this.el.password.value = '';
            await this.load();
        } catch (e) {
            this.setLoginError(e.message === 'Unauthorized' ? '账号或密码错误' : (e.message || '登录失败'));
            this.el.password.value = '';
            this.el.password.focus();
        } finally {
            this.el.login.disabled = false;
            this.el.login.textContent = '登录并进入';
        }
    },

    setLoginError(text) {
        this.el.loginError.textContent = text;
        this.el.loginError.classList.remove('hidden');
    },

    render(summary, logs) {
        const total = summary.total || {};
        this.el.totalRequests.textContent = this.formatInt(total.request_count);
        this.el.totalTokens.textContent = this.formatInt(total.total_tokens);
        this.el.promptTokens.textContent = this.formatInt(total.prompt_tokens);
        this.el.completionTokens.textContent = this.formatInt(total.completion_tokens);
        this.el.cost.textContent = this.formatCost(total.estimated_cost);

        this.el.userRows.innerHTML = this.renderUserRows(summary.by_user || []);
        this.el.featureRows.innerHTML = this.renderFeatureRows(summary.by_feature || []);
        this.el.logRows.innerHTML = this.renderLogRows(logs || []);
        this.renderTrendChart(summary.daily || []);
        this.renderFeatureChart(summary.by_feature || []);
        this.renderPricing(summary.by_model || [], summary.pricing || {});
    },

    renderTrendChart(rows) {
        if (!rows.length) {
            this.el.trendChart.innerHTML = '<div class="usage-chart-empty">当前时间范围暂无趋势数据</div>';
            return;
        }
        const width = 760;
        const height = 240;
        const left = 52;
        const right = 18;
        const top = 20;
        const bottom = 38;
        const plotWidth = width - left - right;
        const plotHeight = height - top - bottom;
        const maxValue = Math.max(...rows.map(row => Number(row.total_tokens || 0)), 1);
        const x = index => left + (rows.length === 1 ? plotWidth / 2 : index * plotWidth / (rows.length - 1));
        const y = value => top + plotHeight - Number(value || 0) / maxValue * plotHeight;
        const path = field => rows.map((row, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(row[field]).toFixed(1)}`).join(' ');
        const grid = [0, .25, .5, .75, 1].map(ratio => {
            const gridY = top + plotHeight * (1 - ratio);
            return `<line x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}" class="usage-grid-line" />
                <text x="${left - 10}" y="${gridY + 4}" text-anchor="end" class="usage-axis-label">${this.compactInt(maxValue * ratio)}</text>`;
        }).join('');
        const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
        const labels = labelIndexes.map(index => `<text x="${x(index)}" y="${height - 10}" text-anchor="middle" class="usage-axis-label">${this.shortDate(rows[index].date)}</text>`).join('');
        const points = rows.map((row, index) => `<circle cx="${x(index)}" cy="${y(row.total_tokens)}" r="3" class="usage-trend-point"><title>${this.escape(row.date)}：${this.formatInt(row.total_tokens)} Token</title></circle>`).join('');
        this.el.trendChart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
            ${grid}
            <path d="${path('prompt_tokens')}" class="usage-trend-line usage-trend-input" />
            <path d="${path('completion_tokens')}" class="usage-trend-line usage-trend-output" />
            <path d="${path('total_tokens')}" class="usage-trend-line usage-trend-total" />
            ${points}${labels}
        </svg>`;
    },

    renderFeatureChart(rows) {
        if (!rows.length) {
            this.el.featureChart.innerHTML = '<div class="usage-chart-empty">暂无功能消耗数据</div>';
            return;
        }
        const visible = rows.slice(0, 6);
        const total = rows.reduce((sum, row) => sum + Number(row.total_tokens || 0), 0) || 1;
        const colors = ['#2563eb', '#0ea5e9', '#8b5cf6', '#14b8a6', '#f59e0b', '#64748b'];
        this.el.featureChart.innerHTML = visible.map((row, index) => {
            const percent = Number(row.total_tokens || 0) / total * 100;
            return `<div class="usage-feature-bar">
                <div class="usage-feature-bar-head"><span>${this.featureName(row.feature)}</span><strong>${percent.toFixed(percent >= 10 ? 0 : 1)}%</strong></div>
                <div class="usage-feature-track"><i style="width:${Math.max(percent, 1)}%;background:${colors[index]}"></i></div>
                <small>${this.formatInt(row.total_tokens)} Token · ${this.formatCost(row.estimated_cost)}</small>
            </div>`;
        }).join('');
    },

    renderPricing(rows, pricing) {
        const defaults = [
            { model: 'deepseek-v4-flash', input_price_per_1m: 1, output_price_per_1m: 2 },
            { model: 'deepseek-v4-pro', input_price_per_1m: 3, output_price_per_1m: 6 },
        ];
        const models = defaults.map(fallback => rows.find(row => {
            const isPro = String(row.model || '').includes('v4-pro');
            return isPro === fallback.model.includes('v4-pro');
        }) || fallback);
        const unique = [];
        models.forEach(model => {
            const tier = String(model.model || '').includes('v4-pro') ? 'DeepSeek V4 Pro' : 'DeepSeek V4 Flash';
            if (!unique.some(item => item.tier === tier)) unique.push({ tier, ...model });
        });
        this.el.pricingList.innerHTML = unique.map(model => `<div class="usage-price-chip">
            <strong>${this.escape(model.tier)}</strong>
            <span>输入 ¥${Number(model.input_price_per_1m || 0).toFixed(2)} / 1M</span>
            <span>输出 ¥${Number(model.output_price_per_1m || 0).toFixed(2)} / 1M</span>
        </div>`).join('');
        if (pricing.source_url) this.el.pricingSource.href = pricing.source_url;
    },

    renderUserRows(rows) {
        if (!rows.length) return '<tr><td colspan="7" class="usage-empty">暂无用量记录</td></tr>';
        return rows.map(row => `
            <tr>
                <td>${this.escape(row.username || `用户 ${row.user_id}`)}</td>
                <td>${this.formatInt(row.request_count)}</td>
                <td>${this.formatInt(row.prompt_tokens)}</td>
                <td>${this.formatInt(row.completion_tokens)}</td>
                <td><strong>${this.formatInt(row.total_tokens)}</strong></td>
                <td>${this.formatInt(row.success_count)} / ${this.formatInt(row.failed_count)}</td>
                <td>${this.formatCost(row.estimated_cost)}</td>
            </tr>
        `).join('');
    },

    renderFeatureRows(rows) {
        if (!rows.length) return '<tr><td colspan="6" class="usage-empty">暂无用量记录</td></tr>';
        return rows.map(row => `
            <tr>
                <td>${this.featureName(row.feature)}</td>
                <td>${this.formatInt(row.request_count)}</td>
                <td>${this.formatInt(row.prompt_tokens)}</td>
                <td>${this.formatInt(row.completion_tokens)}</td>
                <td><strong>${this.formatInt(row.total_tokens)}</strong></td>
                <td>${this.formatCost(row.estimated_cost)}</td>
            </tr>
        `).join('');
    },

    renderLogRows(rows) {
        if (!rows.length) return '<tr><td colspan="8" class="usage-empty">暂无用量记录</td></tr>';
        return rows.map(row => `
            <tr>
                <td>${this.formatTime(row.created_at)}</td>
                <td>${this.escape(row.username || '')}</td>
                <td>${this.featureName(row.feature)}</td>
                <td>${this.escape(row.model || '')}</td>
                <td>${this.formatInt(row.prompt_tokens)}</td>
                <td>${this.formatInt(row.completion_tokens)}</td>
                <td><strong>${this.formatInt(row.total_tokens)}</strong></td>
                <td>${this.formatCost(row.estimated_cost)}</td>
            </tr>
        `).join('');
    },

    featureName(feature) {
        const names = {
            chat: '法律问答',
            chat_title: '会话标题',
            research: '法规/案例检索',
            research_followup: '检索追问',
            document_generate: '文书生成',
            document_extract: '文书信息提取',
            contract_review: '合同审查',
            contract_followup: '合同追问',
        };
        return names[feature] || this.escape(feature || '未知');
    },

    formatInt(value) {
        return Number(value || 0).toLocaleString('zh-CN');
    },

    formatCost(value) {
        const amount = Number(value || 0);
        return `¥${amount.toFixed(amount >= 100 ? 2 : 4)}`;
    },

    compactInt(value) {
        const amount = Number(value || 0);
        if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}m`;
        if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
        return Math.round(amount).toString();
    },

    shortDate(value) {
        if (!value) return '';
        const parts = String(value).split('-');
        return parts.length === 3 ? `${parts[1]}/${parts[2]}` : String(value);
    },

    formatTime(ts) {
        if (!ts) return '';
        return new Date(Number(ts) * 1000).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    },

    escape(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    },
};

document.addEventListener('DOMContentLoaded', () => UsagePage.init());
