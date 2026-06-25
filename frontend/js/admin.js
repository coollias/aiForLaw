/**
 * 管理后台 — 主逻辑
 * Dashboard、用户管理、用量分析、操作记录
 */
const Admin = {
    currentPage: 'dashboard',
    currentUser: null,
    recordsTab: 'contracts',
    recordsPage: 1,
    recordsPageSize: 20,
    recordsTotal: 0,
    charts: {},

    async init() {
        // 检查登录状态
        try {
            const auth = await API.checkAuth();
            if (auth.authenticated && auth.user?.is_admin) {
                this.currentUser = auth.user;
                this.showApp();
                return;
            }
        } catch (e) { /* 未登录 */ }
        this.showLogin();
        this.bindLogin();
    },

    // ===== 登录 =====
    showLogin() {
        document.getElementById('admin-login-page').classList.remove('hidden');
        document.getElementById('admin-app').classList.add('hidden');
        document.getElementById('admin-login-password').focus();
    },

    showApp() {
        document.getElementById('admin-login-page').classList.add('hidden');
        document.getElementById('admin-app').classList.remove('hidden');
        document.getElementById('admin-username-display').textContent = this.currentUser?.username || 'admin';
        this.bindNavigation();
        this.bindLogout();
        this.bindBackToApp();
        this.switchPage('dashboard');
        this.loadDashboard();
        this.bindUserManagement();
        this.bindUsage();
        this.bindRecords();
    },

    bindLogin() {
        const btn = document.getElementById('admin-login-btn');
        const usernameInput = document.getElementById('admin-login-username');
        const passwordInput = document.getElementById('admin-login-password');
        const errorEl = document.getElementById('admin-login-error');

        const doLogin = async () => {
            const username = usernameInput.value.trim() || 'admin';
            const password = passwordInput.value.trim();
            if (!password) return;

            btn.disabled = true;
            btn.textContent = '验证中...';
            errorEl.classList.add('hidden');

            try {
                const result = await API.login(username, password);
                // 检查是否是管理员
                if (!result.user?.is_admin) {
                    throw new Error('当前账号不是管理员，无法进入管理后台');
                }
                this.currentUser = result.user;
                this.showApp();
                this.loadDashboard();
            } catch (e) {
                errorEl.textContent = e.message || '登录失败';
                errorEl.classList.remove('hidden');
                passwordInput.value = '';
                passwordInput.focus();
            } finally {
                btn.disabled = false;
                btn.textContent = '进入管理后台';
            }
        };

        btn.addEventListener('click', doLogin);
        passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    },

    bindLogout() {
        document.getElementById('admin-logout-btn').addEventListener('click', async () => {
            await API.logout().catch(() => {});
            this.currentUser = null;
            this.showLogin();
        });
    },

    bindBackToApp() {
        document.getElementById('admin-back-to-app').addEventListener('click', () => {
            window.location.href = '/';
        });
    },

    // ===== 导航 =====
    bindNavigation() {
        document.querySelectorAll('.admin-nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = btn.dataset.page;
                this.switchPage(page);
            });
        });
    },

    switchPage(page) {
        this.currentPage = page;
        document.querySelectorAll('.admin-nav-item').forEach(b => b.classList.remove('active'));
        document.querySelector(`.admin-nav-item[data-page="${page}"]`)?.classList.add('active');
        document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('active'));
        document.getElementById(`page-${page}`)?.classList.add('active');

        if (page === 'dashboard') this.loadDashboard();
        if (page === 'users') this.loadUsers();
        if (page === 'usage') this.loadUsage();
        if (page === 'records') this.loadRecords();
    },

    // ===== 仪表盘 =====
    async loadDashboard() {
        try {
            const data = await API.get('/api/admin/dashboard');
            this.renderStats(data.stats);
            this.renderSummary(data.stats);
            this.renderDailyChart(data.daily_trend);
            this.renderCostChart(data.daily_trend);
        } catch (e) {
            console.error('Dashboard 加载失败:', e);
        }
    },

    renderStats(stats) {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val ?? '-';
        };
        set('stat-total-users', stats.total_users);
        set('stat-active-users', stats.active_users);
        set('stat-new-users-7d', stats.new_users_7d);
        set('stat-sessions-today', stats.active_sessions_today);
        set('stat-messages-today', stats.messages_today);
        set('stat-api-calls-today', stats.api_calls_today);
        set('stat-cost-today', stats.cost_today?.toFixed(4));
        set('stat-cost-30d', stats.cost_30d?.toFixed(2));
    },

    renderSummary(stats) {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val ?? '-';
        };
        set('stat-total-sessions', stats.total_sessions);
        set('stat-total-reviews', stats.total_reviews);
        set('stat-total-research', stats.total_research);
        set('stat-total-translations', stats.total_translations);
        set('stat-reviews-7d', stats.reviews_7d);
        set('stat-research-7d', stats.research_7d);
        set('stat-api-30d', stats.api_calls_30d);
    },

    renderDailyChart(trend) {
        if (!trend || !trend.length) return;
        const dates = trend.map(d => d.date.slice(5));
        const apiCalls = trend.map(d => d.api_calls);
        const messages = trend.map(d => d.messages);

        if (this.charts.dailyCalls) this.charts.dailyCalls.destroy();
        const ctx = document.getElementById('chart-daily-calls');
        if (!ctx) return;
        this.charts.dailyCalls = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: dates,
                datasets: [
                    { label: 'API 调用', data: apiCalls, backgroundColor: 'rgba(37, 99, 235, 0.6)', borderRadius: 3 },
                    { label: '消息数', data: messages, backgroundColor: 'rgba(16, 185, 129, 0.6)', borderRadius: 3 },
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } } },
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                    y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 } }
                }
            }
        });
    },

    renderCostChart(trend) {
        if (!trend || !trend.length) return;
        const dates = trend.map(d => d.date.slice(5));
        const costs = trend.map(d => d.cost);

        if (this.charts.dailyCost) this.charts.dailyCost.destroy();
        const ctx = document.getElementById('chart-daily-cost');
        if (!ctx) return;
        this.charts.dailyCost = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dates,
                datasets: [{
                    label: '费用 (¥)',
                    data: costs,
                    borderColor: '#e8496a',
                    backgroundColor: 'rgba(232, 73, 106, 0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } } },
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                    y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => '¥' + v.toFixed(4) } }
                }
            }
        });
    },

    // ===== 用户管理 =====
    bindUserManagement() {
        document.getElementById('admin-show-create-user').addEventListener('click', () => {
            document.getElementById('admin-create-user-panel').classList.remove('hidden');
        });
        document.getElementById('admin-cancel-create-user').addEventListener('click', () => {
            document.getElementById('admin-create-user-panel').classList.add('hidden');
        });
        document.getElementById('admin-create-user-btn').addEventListener('click', () => this.createUser());
        document.getElementById('admin-refresh-users').addEventListener('click', () => this.loadUsers());
    },

    async loadUsers() {
        const tbody = document.getElementById('admin-user-tbody');
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">加载中...</td></tr>';
        try {
            const data = await API.listUsers();
            const users = data.users || [];
            const adminCount = users.filter(u => u.is_admin).length;
            const activeCount = users.filter(u => u.is_active).length;
            document.getElementById('user-list-summary').textContent =
                `共 ${users.length} 个账号，${activeCount} 个启用，${adminCount} 个管理员`;

            tbody.innerHTML = users.map(user => `
                <tr data-user-id="${user.id}">
                    <td>${user.id}</td>
                    <td><strong>${this.esc(user.username)}</strong></td>
                    <td><span class="user-tag ${user.is_admin ? 'admin' : ''}">${user.is_admin ? '管理员' : '普通用户'}</span></td>
                    <td><span class="user-tag ${user.is_active ? '' : 'disabled'}">${user.is_active ? '启用' : '停用'}</span></td>
                    <td>${this.formatTime(user.created_at)}</td>
                    <td>
                        <div class="action-group">
                            ${user.id !== this.currentUser?.id ? `
                                <button class="mini-btn admin-toggle-admin" data-admin="${user.is_admin}">${user.is_admin ? '取消管理' : '设为管理'}</button>
                                <button class="mini-btn admin-toggle-active" data-active="${user.is_active}">${user.is_active ? '停用' : '启用'}</button>
                            ` : ''}
                            <button class="mini-btn admin-reset-pwd">改密码</button>
                            <button class="mini-btn admin-token-info">会话</button>
                        </div>
                    </td>
                </tr>
            `).join('');

            // 绑定操作
            tbody.querySelectorAll('.admin-toggle-admin').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const tr = btn.closest('tr');
                    const userId = parseInt(tr.dataset.userId);
                    const isAdmin = btn.dataset.admin === 'true';
                    await this.updateUser(userId, { is_admin: !isAdmin });
                });
            });
            tbody.querySelectorAll('.admin-toggle-active').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const tr = btn.closest('tr');
                    const userId = parseInt(tr.dataset.userId);
                    const isActive = btn.dataset.active === 'true';
                    await this.updateUser(userId, { is_active: !isActive });
                });
            });
            tbody.querySelectorAll('.admin-reset-pwd').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const tr = btn.closest('tr');
                    const userId = parseInt(tr.dataset.userId);
                    const username = tr.querySelector('strong')?.textContent || '';
                    const password = prompt(`请输入 ${username} 的新密码：`);
                    if (password) await this.updateUser(userId, { password });
                });
            });
            tbody.querySelectorAll('.admin-token-info').forEach(btn => {
                btn.addEventListener('click', () => {
                    alert('会话管理功能即将推出');
                });
            });
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state">加载失败：${this.esc(e.message)}</td></tr>`;
        }
    },

    async createUser() {
        const username = document.getElementById('admin-new-username').value.trim();
        const password = document.getElementById('admin-new-password').value.trim();
        const isAdmin = document.getElementById('admin-new-is-admin').checked;
        if (!username || !password) {
            alert('请填写用户名和密码');
            return;
        }
        try {
            await API.createUser(username, password, isAdmin);
            document.getElementById('admin-new-username').value = '';
            document.getElementById('admin-new-password').value = '';
            document.getElementById('admin-new-is-admin').checked = false;
            document.getElementById('admin-create-user-panel').classList.add('hidden');
            await this.loadUsers();
        } catch (e) {
            alert(e.message);
        }
    },

    async updateUser(userId, updates) {
        try {
            await API.updateUser(userId, updates);
            await this.loadUsers();
        } catch (e) {
            alert(e.message);
            await this.loadUsers();
        }
    },

    // ===== 用量分析 =====
    bindUsage() {
        document.getElementById('admin-refresh-usage').addEventListener('click', () => this.loadUsage());
    },

    async loadUsage() {
        const days = document.getElementById('usage-days-select')?.value || 30;
        const summaryEl = document.getElementById('usage-summary-cards');
        summaryEl.innerHTML = '<div class="stat-card"><div class="stat-value">加载中...</div><div class="stat-label">请稍候</div></div>';

        try {
            const data = await API.get(`/api/admin/usage/summary?days=${days}`);
            this.renderUsageSummary(data);
            this.renderUsageByUser(data.by_user);
            this.renderUsageByFeature(data.by_feature);
            this.renderUsageByModel(data.by_model);
            this.renderUsageDailyChart(data.daily);
        } catch (e) {
            summaryEl.innerHTML = `<div class="stat-card"><div class="stat-value" style="font-size:14px;color:#e8496a;">加载失败</div><div class="stat-label">${this.esc(e.message)}</div></div>`;
        }
    },

    renderUsageSummary(data) {
        const total = data.total || {};
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val ?? '-';
        };
        set('usage-total-calls', total.request_count ?? 0);
        set('usage-total-tokens', this.formatNumber(total.total_tokens ?? 0));
        set('usage-total-cost', (total.estimated_cost ?? 0).toFixed(4));
        set('usage-failed-count', total.failed_count ?? 0);
    },

    renderUsageByUser(users) {
        const tbody = document.getElementById('usage-by-user-tbody');
        if (!users || !users.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无数据</td></tr>';
            return;
        }
        tbody.innerHTML = users.map(u => `
            <tr>
                <td>${this.esc(u.username || '(未知)')}</td>
                <td>${u.request_count}</td>
                <td>${this.formatNumber(u.prompt_tokens)}</td>
                <td>${this.formatNumber(u.completion_tokens)}</td>
                <td>${this.formatNumber(u.total_tokens)}</td>
                <td>${(u.estimated_cost || 0).toFixed(4)}</td>
                <td>${u.success_count ?? 0}/${u.failed_count ?? 0}</td>
            </tr>
        `).join('');
    },

    renderUsageByFeature(features) {
        const tbody = document.getElementById('usage-by-feature-tbody');
        if (!features || !features.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无数据</td></tr>';
            return;
        }
        tbody.innerHTML = features.map(f => `
            <tr>
                <td>${this.esc(f.feature || '(未知)')}</td>
                <td>${f.request_count}</td>
                <td>${this.formatNumber(f.prompt_tokens)}</td>
                <td>${this.formatNumber(f.completion_tokens)}</td>
                <td>${this.formatNumber(f.total_tokens)}</td>
                <td>${(f.estimated_cost || 0).toFixed(4)}</td>
            </tr>
        `).join('');
    },

    renderUsageByModel(models) {
        const tbody = document.getElementById('usage-by-model-tbody');
        if (!models || !models.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无数据</td></tr>';
            return;
        }
        tbody.innerHTML = models.map(m => `
            <tr>
                <td><code>${this.esc(m.model || '(未知)')}</code></td>
                <td>${m.request_count}</td>
                <td>${this.formatNumber(m.prompt_tokens)}</td>
                <td>${this.formatNumber(m.completion_tokens)}</td>
                <td>${this.formatNumber(m.total_tokens)}</td>
                <td>${(m.estimated_cost || 0).toFixed(4)}</td>
                <td>${(m.input_price_per_1m || 0).toFixed(2)} / ${(m.output_price_per_1m || 0).toFixed(2)}</td>
            </tr>
        `).join('');
    },

    renderUsageDailyChart(daily) {
        if (!daily || !daily.length) return;
        const dates = daily.map(d => d.date);
        const totalTokens = daily.map(d => d.total_tokens || 0);

        if (this.charts.usageDaily) this.charts.usageDaily.destroy();
        const ctx = document.getElementById('chart-usage-daily');
        if (!ctx) return;
        this.charts.usageDaily = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: dates,
                datasets: [{
                    label: 'Token 消耗',
                    data: totalTokens,
                    backgroundColor: 'rgba(99, 102, 241, 0.6)',
                    borderRadius: 3,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                    y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => this.formatNumber(v) } }
                }
            }
        });
    },

    // ===== 操作记录 =====
    bindRecords() {
        document.querySelectorAll('[data-record-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-record-tab]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.recordsTab = btn.dataset.recordTab;
                this.recordsPage = 1;
                this.loadRecords();
            });
        });
        document.getElementById('records-search-btn').addEventListener('click', () => {
            this.recordsPage = 1;
            this.loadRecords();
        });
        document.getElementById('records-prev-page').addEventListener('click', () => {
            if (this.recordsPage > 1) {
                this.recordsPage--;
                this.loadRecords();
            }
        });
        document.getElementById('records-next-page').addEventListener('click', () => {
            if (this.recordsPage * this.recordsPageSize < this.recordsTotal) {
                this.recordsPage++;
                this.loadRecords();
            }
        });
    },

    async loadRecords() {
        const tab = this.recordsTab;
        const username = document.getElementById('records-username-filter')?.value?.trim() || '';
        const start = document.getElementById('records-start-date')?.value || '';
        const end = document.getElementById('records-end-date')?.value || '';

        let url = `/api/admin/records/${tab}?page=${this.recordsPage}&page_size=${this.recordsPageSize}`;
        if (username) url += `&username=${encodeURIComponent(username)}`;
        if (start) url += `&start=${start}`;
        if (end) url += `&end=${end}`;

        try {
            const data = await API.get(url);
            this.recordsTotal = data.total || 0;
            this.renderRecordTable(tab, data.records || []);
            this.renderPagination(data.page, data.total);
        } catch (e) {
            document.getElementById('records-tbody').innerHTML =
                `<tr><td colspan="6" class="empty-state">加载失败：${this.esc(e.message)}</td></tr>`;
        }
    },

    renderRecordTable(tab, records) {
        const thead = document.getElementById('records-thead');
        const tbody = document.getElementById('records-tbody');

        const headers = {
            contracts: ['用户', '文件名', '风险等级', '风险点', '备注', '审查时间'],
            research: ['用户', '检索关键词', '法规数', '案例数', '检索时间'],
            translations: ['用户', '文件名', '源语言', '目标语言', '进度', '翻译时间'],
        };

        thead.innerHTML = `<tr>${(headers[tab] || []).map(h => `<th>${h}</th>`).join('')}</tr>`;

        if (!records.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无记录</td></tr>';
            return;
        }

        if (tab === 'contracts') {
            tbody.innerHTML = records.map(r => `
                <tr>
                    <td>${this.esc(r.username)}</td>
                    <td>${this.esc(r.filename)}</td>
                    <td><span class="risk-tag ${r.overall_risk}">${this.riskLabel(r.overall_risk)}</span></td>
                    <td>${r.issue_count}</td>
                    <td>${this.esc(r.note?.slice(0, 40)) || '-'}</td>
                    <td>${this.formatTime(r.created_at)}</td>
                </tr>
            `).join('');
        } else if (tab === 'research') {
            tbody.innerHTML = records.map(r => `
                <tr>
                    <td>${this.esc(r.username)}</td>
                    <td title="${this.esc(r.query)}">${this.esc(r.query?.slice(0, 40)) || '-'}</td>
                    <td>${r.law_count}</td>
                    <td>${r.case_count}</td>
                    <td>${this.formatTime(r.created_at)}</td>
                </tr>
            `).join('');
        } else if (tab === 'translations') {
            tbody.innerHTML = records.map(r => `
                <tr>
                    <td>${this.esc(r.username)}</td>
                    <td>${this.esc(r.filename)}</td>
                    <td>${this.esc(r.source_lang)}</td>
                    <td>${this.esc(r.target_lang)}</td>
                    <td>${r.progress}</td>
                    <td>${this.formatTime(r.created_at)}</td>
                </tr>
            `).join('');
        }
    },

    renderPagination(page, total) {
        const totalPages = Math.ceil(total / this.recordsPageSize) || 1;
        document.getElementById('records-page-info').textContent = `第 ${page} 页 / 共 ${totalPages} 页（${total} 条）`;
        document.getElementById('records-prev-page').disabled = page <= 1;
        document.getElementById('records-next-page').disabled = page >= totalPages;
    },

    // ===== 工具函数 =====
    riskLabel(risk) {
        const map = { high: '高风险', medium: '中风险', low: '低风险' };
        return map[risk] || risk || '未知';
    },

    esc(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    },

    formatTime(ts) {
        if (!ts) return '-';
        const d = new Date(ts * 1000);
        return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },

    formatNumber(n) {
        if (n == null) return '0';
        return Number(n).toLocaleString();
    },
};

document.addEventListener('DOMContentLoaded', () => Admin.init());
