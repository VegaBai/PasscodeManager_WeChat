const ALNUM = /^[A-Za-z0-9]+$/;

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  return new Date(value);
}

function pad(value) {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatClock(value) {
  const date = toDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function minutesUntil(value, nowTs) {
  const date = toDate(value);
  if (!date || Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.ceil((date.getTime() - nowTs) / 60000));
}

Page({
  data: {
    loading: false,
    bindingGroup: false,
    switchGroupDialogOpen: false,
    savingQueue: false,
    openid: '',
    groups: [],
    currentGroup: null,
    currentGroupIndex: 0,
    username: '',
    password: '',
    queueOpen: false,
    courtName: '',
    courtRemainingMinutes: '',
    courtAheadGroups: '',
    targetQueueEntryId: '',
    halfGroupOptions: [],
    cancelDialogOpen: false,
    cancelEntryId: '',
    cancelOptions: [],
    cancelSelectedIds: [],
    cancelCanConfirm: false,
    selectedIds: [],
    credentials: [],
    sortedCredentials: [],
    idleCredentials: [],
    queueEntries: [],
    stats: {
      total: 0,
      idle: 0,
      playing: 0,
      queued: 0
    },
    courtStats: {
      playingCount: 0,
      playingText: '无',
      playingItems: [],
      queuedCount: 0,
      queuedText: '无',
      queuedItems: []
    },
    courtPreview: {
      nextGroupNo: 0,
      remainingMinutes: 0,
      waitMinutes: 0,
      hasTrackedCourt: false
    },
    nowTs: Date.now()
  },

  onLoad(options) {
    this.pageOptions = options || {};

    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage']
    });

    this.tickTimer = setInterval(() => {
      this.setData({ nowTs: Date.now() });
      this.rebuildViewData();
    }, 30000);
    this.init();
  },

  onShow() {
    this.bindWeChatGroupFromEnterOptions();
  },

  onUnload() {
    if (this.tickTimer) clearInterval(this.tickTimer);
  },

  onShareAppMessage() {
    return {
      title: '羽毛球排队账号池',
      path: '/pages/group-dashboard/group-dashboard?fromGroupShare=1'
    };
  },

  async init() {
    try {
      const result = await this.callApi('init', {});
      const currentGroupId = wx.getStorageSync('currentGroupId');
      this.setData({
        openid: result.openid,
        groups: this.normalizeGroups(result.groups || [])
      });
      this.pickCurrentGroup(currentGroupId);
      await this.bindWeChatGroupFromEnterOptions();
      await this.refreshDashboard();
    } catch (error) {
      this.showError(error);
    }
  },

  async callApi(action, payload) {
    let response;

    try {
      response = await wx.cloud.callFunction({
        name: 'api',
        data: {
          action,
          payload
        }
      });
    } catch (error) {
      const detail = error.errMsg || error.message || JSON.stringify(error);
      throw new Error(`云函数调用失败：${detail}`);
    }

    if (!response.result || !response.result.ok) {
      throw new Error((response.result && response.result.message) || '操作失败');
    }
    return response.result.data || {};
  },

  async callBindWeChatGroup(cloudID) {
    let response;

    try {
      response = await wx.cloud.callFunction({
        name: 'api',
        data: {
          action: 'bindWeChatGroup',
          groupInfo: wx.cloud.CloudID(cloudID)
        }
      });
    } catch (error) {
      const detail = error.errMsg || error.message || JSON.stringify(error);
      throw new Error(`云函数调用失败：${detail}`);
    }

    if (!response.result || !response.result.ok) {
      throw new Error((response.result && response.result.message) || '绑定微信群失败');
    }
    return response.result.data || {};
  },

  async bindWeChatGroupFromEnterOptions() {
    const app = getApp();
    const enterOptions = (app.globalData && app.globalData.enterOptions) || (wx.getEnterOptionsSync && wx.getEnterOptionsSync());
    const query = (enterOptions && enterOptions.query) || this.pageOptions || {};
    const shareTicket = enterOptions && enterOptions.shareTicket;
    const isGroupSharePath = query.fromGroupShare === '1';

    if (!this.data.openid) return;
    if (!shareTicket && !isGroupSharePath) return;

    const bindKey = shareTicket || `group-share-path-${JSON.stringify(query)}`;
    if (this.lastBoundShareTicket === bindKey) return;

    this.lastBoundShareTicket = bindKey;
    this.setData({ bindingGroup: true });

    try {
      const groupInfo = await this.getWeChatGroupInfo(shareTicket);
      if (!groupInfo.cloudID) throw new Error('没有拿到微信群信息');

      const result = await this.callBindWeChatGroup(groupInfo.cloudID);

      this.setData({
        groups: this.normalizeGroups(result.groups || [])
      });
      this.pickCurrentGroup(result.groupId);
      await this.refreshDashboard();
    } catch (error) {
      if (isGroupSharePath) {
        wx.showModal({
          title: '未拿到微信群信息',
          content: error.message || '请从微信群里的小程序卡片打开。如果仍失败，请完全关闭小程序后再从群卡片打开。',
          showCancel: false
        });
      }
    } finally {
      this.setData({ bindingGroup: false });
    }
  },

  getWeChatGroupInfo(shareTicket) {
    return new Promise((resolve, reject) => {
      if (wx.getGroupEnterInfo) {
        wx.getGroupEnterInfo({
          success: resolve,
          fail: (error) => {
            if (!shareTicket) {
              reject(error);
              return;
            }

            wx.getShareInfo({
              shareTicket,
              success: resolve,
              fail: reject
            });
          }
        });
        return;
      }

      if (!shareTicket) {
        reject(new Error('缺少 shareTicket'));
        return;
      }

      wx.getShareInfo({
        shareTicket,
        success: resolve,
        fail: reject
      });
    });
  },

  showError(error) {
    const message = error.message || '操作失败';
    if (message.length > 14) {
      wx.showModal({
        title: '操作失败',
        content: message,
        showCancel: false
      });
      return;
    }

    wx.showToast({
      title: message,
      icon: 'none'
    });
  },

  openSwitchGroupDialog() {
    this.setData({ switchGroupDialogOpen: true });
  },

  closeSwitchGroupDialog() {
    this.setData({ switchGroupDialogOpen: false });
  },

  normalizeGroups(groups) {
    return (groups || []).map((group) => {
      const shortId = group.openGId ? group.openGId.slice(-6) : '';
      const displayName = group.openGId && (!group.name || group.name === '微信群羽毛球排队')
        ? `微信群 ${shortId}`
        : (group.name || (shortId ? `微信群 ${shortId}` : '羽毛球群'));
      return {
        ...group,
        openGIdShort: shortId ? `群标识 ${shortId}` : '',
        displayName
      };
    });
  },

  pickCurrentGroup(groupId) {
    const groups = this.data.groups || [];
    let index = groups.findIndex((group) => group._id === groupId);
    if (index < 0 && groups.length) index = 0;
    const currentGroup = index >= 0 ? groups[index] : null;
    this.setData({
      currentGroup,
      currentGroupIndex: index >= 0 ? index : 0
    });
    if (currentGroup) wx.setStorageSync('currentGroupId', currentGroup._id);
  },

  async refreshDashboard() {
    const groupId = this.data.currentGroup && this.data.currentGroup._id;
    if (!groupId) {
      this.rebuildViewData();
      return;
    }

    this.setData({ loading: true });
    try {
      const result = await this.callApi('getDashboard', { groupId });
      this.setData({
        groups: this.normalizeGroups(result.groups || this.data.groups),
        currentGroup: result.currentGroup || this.data.currentGroup,
        credentials: result.credentials || [],
        queueEntries: result.queueEntries || [],
        nowTs: result.now ? new Date(result.now).getTime() : Date.now()
      });
      this.pickCurrentGroup(groupId);
      this.rebuildViewData();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ loading: false });
    }
  },

  rebuildViewData() {
    const nowTs = this.data.nowTs || Date.now();
    const selectedSet = new Set(this.data.selectedIds);
    const entriesById = {};

    (this.data.queueEntries || []).forEach((entry) => {
      entriesById[entry._id] = entry;
    });

    const statusText = {
      idle: '空闲',
      playing: '正在打',
      queued: '排队中'
    };
    const statusRank = {
      idle: 0,
      playing: 1,
      queued: 2
    };

    const credentials = (this.data.credentials || []).map((item) => {
      const entry = item.currentQueueEntryId ? entriesById[item.currentQueueEntryId] : null;
      let timeText = '';
      if (item.status === 'playing' && entry) {
        timeText = `剩余 ${minutesUntil(entry.endAt, nowTs)} 分钟`;
      } else if (item.status === 'queued' && entry) {
        timeText = `预计 ${formatClock(entry.startAt)} 上场`;
      }

      return {
        ...item,
        statusText: statusText[item.status] || item.status,
        courtName: item.currentCourtName || (entry && entry.courtName) || '',
        groupNo: entry && entry.groupNo,
        hasGroupNo: Boolean(entry) && entry.groupNo !== undefined && entry.groupNo !== null,
        timeText,
        ownerText: item.createdByOpenid === this.data.openid ? '我添加的' : '群成员添加',
        canDelete: item.createdByOpenid === this.data.openid && item.status === 'idle',
        canCancelQueue: item.status === 'playing' || item.status === 'queued',
        selected: selectedSet.has(item._id)
      };
    });

    const sortedCredentials = credentials.slice().sort((a, b) => {
      const rankDelta = (statusRank[a.status] || 9) - (statusRank[b.status] || 9);
      if (rankDelta) return rankDelta;
      const courtDelta = String(a.courtName || '').localeCompare(String(b.courtName || ''));
      if (courtDelta) return courtDelta;
      return String(a.username).localeCompare(String(b.username));
    });

    const idleCredentials = sortedCredentials.filter((item) => item.status === 'idle');
    const stats = {
      total: credentials.length,
      idle: credentials.filter((item) => item.status === 'idle').length,
      playing: credentials.filter((item) => item.status === 'playing').length,
      queued: credentials.filter((item) => item.status === 'queued').length
    };
    const courtStats = this.buildCourtStats();

    this.setData({
      sortedCredentials,
      idleCredentials,
      stats,
      courtStats,
      halfGroupOptions: this.buildHalfGroupOptions(),
      courtPreview: this.buildCourtPreview()
    });
  },

  buildHalfGroupOptions() {
    const courtName = String(this.data.courtName || '').trim();
    if (!courtName) return [];

    return (this.data.queueEntries || [])
      .filter((entry) => {
        const participantCount = this.entryParticipantCount(entry);
        return entry.courtName === courtName
          && ['playing', 'queued'].includes(entry.status)
          && participantCount === 2
          && Number(entry.groupNo) >= 0;
      })
      .sort((a, b) => Number(a.groupNo) - Number(b.groupNo))
      .map((entry) => ({
        id: entry._id,
        groupNo: entry.groupNo,
        statusText: entry.status === 'playing' ? '正在打' : '排队中',
        label: entry.isExternal && !(entry.credentialIds || []).length
          ? `加入第 ${entry.groupNo} 组半场`
          : `补全第 ${entry.groupNo} 组半场`
      }));
  },

  buildCourtStats() {
    const nowTs = this.data.nowTs || Date.now();
    const playingCourts = {};
    const queuedEntries = [];

    (this.data.queueEntries || []).forEach((entry) => {
      if (!entry.courtName) return;
      if (!(entry.credentialIds || []).length) return;
      if (entry.status === 'playing') this.collectCourtStat(playingCourts, entry, nowTs);
      if (entry.status === 'queued') queuedEntries.push(entry);
    });

    const playingItems = this.courtStatItems(playingCourts);
    const queuedItems = this.queueCourtStatItems(queuedEntries);

    return {
      playingCount: playingItems.length,
      playingText: playingItems.length ? playingItems.map((item) => item.label).join('、') : '无',
      playingItems,
      queuedCount: queuedItems.length,
      queuedText: queuedItems.length ? queuedItems.map((item) => item.label).join('、') : '无',
      queuedItems
    };
  },

  collectCourtStat(target, entry, nowTs) {
    const courtName = String(entry.courtName);
    if (!target[courtName]) {
      target[courtName] = {
        courtName,
        isHalf: false,
        minutes: minutesUntil(entry.endAt, nowTs)
      };
    }
    if ((entry.credentialIds || []).length === 2) {
      target[courtName].isHalf = true;
    }
    target[courtName].minutes = Math.min(
      target[courtName].minutes,
      minutesUntil(entry.endAt, nowTs)
    );
  },

  courtStatItems(courts) {
    return Object.keys(courts).sort().map((courtName) => {
      const item = courts[courtName];
      return {
        key: courtName,
        courtName,
        isHalf: item.isHalf,
        minutes: item.minutes,
        hasMinutes: item.minutes !== undefined && item.minutes !== null,
        label: `${courtName}${item.isHalf ? '半' : ''}`
      };
    });
  },

  queueCourtStatItems(entries) {
    const nowTs = this.data.nowTs || Date.now();
    const shownMinuteCourts = new Set();
    return entries
      .slice()
      .sort((a, b) => {
        const groupDelta = Number(a.groupNo || 0) - Number(b.groupNo || 0);
        if (groupDelta) return groupDelta;
        return String(a.courtName).localeCompare(String(b.courtName));
      })
      .map((entry, index) => {
        const courtName = String(entry.courtName);
        const isHalf = (entry.credentialIds || []).length === 2;
        const shouldShowMinutes = !shownMinuteCourts.has(courtName);
        shownMinuteCourts.add(courtName);
        return {
          key: entry._id || `${courtName}-${entry.groupNo}-${index}`,
          courtName,
          isHalf,
          minutes: shouldShowMinutes ? minutesUntil(entry.startAt, nowTs) : 0,
          hasMinutes: shouldShowMinutes,
          label: `${courtName}${isHalf ? '半' : ''}`
        };
      });
  },

  entryParticipantCount(entry) {
    const credentialCount = (entry.credentialIds || []).length;
    const externalCount = Number(entry.externalCredentialCount || 0);
    if (entry.isExternal && !credentialCount && !externalCount) return 2;
    return credentialCount + externalCount;
  },

  buildCourtPreview() {
    const courtName = String(this.data.courtName || '').trim();
    const nowTs = this.data.nowTs || Date.now();
    const manualRemaining = this.parseRemainingMinutes(this.data.courtRemainingMinutes);
    const aheadGroups = this.parseAheadGroups(this.data.courtAheadGroups);
    if (!courtName) {
      const waitMinutes = manualRemaining + aheadGroups * 45;
      return {
        nextGroupNo: (manualRemaining > 0 ? 1 : 0) + aheadGroups,
        remainingMinutes: manualRemaining,
        waitMinutes,
        hasTrackedCourt: false
      };
    }

    const entries = (this.data.queueEntries || []).filter((entry) => entry.courtName === courtName);
    const playing = entries.find((entry) => entry.status === 'playing');
    const queued = entries.filter((entry) => entry.status === 'queued');
    const hasTrackedCourt = Boolean(entries.length);
    if (!hasTrackedCourt) {
      const waitMinutes = manualRemaining + aheadGroups * 45;
      return {
        nextGroupNo: (manualRemaining > 0 ? 1 : 0) + aheadGroups,
        remainingMinutes: manualRemaining,
        waitMinutes,
        hasTrackedCourt: false
      };
    }

    const targetEntry = this.data.targetQueueEntryId
      ? entries.find((entry) => entry._id === this.data.targetQueueEntryId)
      : null;
    if (targetEntry) {
      return {
        nextGroupNo: Number(targetEntry.groupNo || 0),
        remainingMinutes: targetEntry.status === 'playing' ? minutesUntil(targetEntry.endAt, nowTs) : 0,
        waitMinutes: targetEntry.status === 'queued' ? minutesUntil(targetEntry.startAt, nowTs) : 0,
        hasTrackedCourt: true
      };
    }

    const hasCurrentGroup = Boolean(playing);
    const waitUntil = queued.length ? queued[queued.length - 1].endAt : (playing && playing.endAt);

    return {
      nextGroupNo: (hasCurrentGroup ? 1 : 0) + queued.length,
      remainingMinutes: playing ? minutesUntil(playing.endAt, nowTs) : 0,
      waitMinutes: waitUntil ? minutesUntil(waitUntil, nowTs) : 0,
      hasTrackedCourt: true
    };
  },

  parseRemainingMinutes(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return 0;
    return Math.max(0, Math.min(45, Math.floor(minutes)));
  },

  parseAheadGroups(value) {
    const groups = Number(value);
    if (!Number.isFinite(groups)) return 0;
    return Math.max(0, Math.min(20, Math.floor(groups)));
  },

  onUsernameInput(event) {
    this.setData({ username: event.detail.value });
  },

  onPasswordInput(event) {
    this.setData({ password: event.detail.value });
  },

  onCourtNameInput(event) {
    this.setData({
      courtName: event.detail.value,
      targetQueueEntryId: ''
    });
    this.rebuildViewData();
  },

  onCourtRemainingInput(event) {
    this.setData({ courtRemainingMinutes: event.detail.value });
    this.rebuildViewData();
  },

  onCourtAheadGroupsInput(event) {
    this.setData({ courtAheadGroups: event.detail.value });
    this.rebuildViewData();
  },

  onGroupChange(event) {
    const index = Number(event.detail.value);
    const group = this.data.groups[index];
    if (!group) return;
    this.setData({
      currentGroup: group,
      currentGroupIndex: index,
      selectedIds: []
    });
    wx.setStorageSync('currentGroupId', group._id);
    this.refreshDashboard();
  },

  async addCredential() {
    const username = String(this.data.username || '').trim();
    const password = String(this.data.password || '').trim();
    const groupId = this.data.currentGroup && this.data.currentGroup._id;

    if (!ALNUM.test(username) || !ALNUM.test(password)) {
      this.showError(new Error('用户名和密码只能包含英文或数字'));
      return;
    }

    try {
      await this.callApi('addCredential', {
        groupId,
        username,
        password
      });
      this.setData({
        username: '',
        password: ''
      });
      await this.refreshDashboard();
    } catch (error) {
      this.showError(error);
    }
  },

  async deleteCredential(event) {
    const id = event.currentTarget.dataset.id;
    const confirmed = await this.confirmAction('删除账号', '确定删除这个用户名和密码吗？');
    if (!confirmed) return;

    try {
      await this.callApi('deleteCredential', {
        groupId: this.data.currentGroup._id,
        credentialId: id
      });
      await this.refreshDashboard();
    } catch (error) {
      this.showError(error);
    }
  },

  toggleQueuePanel() {
    this.setData({ queueOpen: !this.data.queueOpen });
  },

  onQueueSelect(event) {
    this.setData({ selectedIds: event.detail.value });
    this.rebuildViewData();
  },

  onHalfGroupChange(event) {
    const value = event.detail.value;
    this.setData({
      targetQueueEntryId: value === '__new__' ? '' : value
    });
    this.rebuildViewData();
  },

  async addQueueEntry() {
    const selectedIds = this.data.selectedIds || [];
    const courtName = String(this.data.courtName || '').trim();

    if (!courtName) {
      this.showError(new Error('请输入场地编号'));
      return;
    }
    if (this.data.targetQueueEntryId && selectedIds.length !== 2) {
      this.showError(new Error('补全半场请选择 2 个账号'));
      return;
    }
    if (!this.data.targetQueueEntryId && !(selectedIds.length === 2 || selectedIds.length === 4)) {
      this.showError(new Error('请选择 2 个或 4 个账号'));
      return;
    }

    this.setData({ savingQueue: true });
    try {
      await this.callApi('addQueueEntry', {
        groupId: this.data.currentGroup._id,
        courtName,
        courtRemainingMinutes: this.parseRemainingMinutes(this.data.courtRemainingMinutes),
        courtAheadGroups: this.parseAheadGroups(this.data.courtAheadGroups),
        targetQueueEntryId: this.data.targetQueueEntryId,
        credentialIds: selectedIds
      });
      this.setData({
        selectedIds: [],
        courtRemainingMinutes: '',
        courtAheadGroups: '',
        targetQueueEntryId: '',
        queueOpen: false
      });
      await this.refreshDashboard();
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ savingQueue: false });
    }
  },

  async cancelQueueEntry(event) {
    const entryId = event.currentTarget.dataset.entryId;
    if (!entryId) return;

    const entry = (this.data.queueEntries || []).find((item) => item._id === entryId);
    if (!entry) return;

    const credentialIds = entry.credentialIds || [];
    if (credentialIds.length === 4) {
      this.openCancelDialog(entry);
      return;
    }

    const confirmed = await this.confirmAction('取消排队', '确定取消这一组排队或正在打的记录吗？');
    if (!confirmed) return;

    try {
      await this.callApi('cancelQueueEntry', {
        groupId: this.data.currentGroup._id,
        queueEntryId: entryId,
        cancelCredentialIds: credentialIds
      });
      await this.refreshDashboard();
    } catch (error) {
      this.showError(error);
    }
  },

  openCancelDialog(entry) {
    const credentialsById = {};
    (this.data.credentials || []).forEach((credential) => {
      credentialsById[credential._id] = credential;
    });

    const cancelOptions = (entry.credentialIds || []).map((id) => {
      const credential = credentialsById[id] || {};
      return {
        id,
        username: credential.username || id,
        password: credential.password || ''
      };
    });

    this.setData({
      cancelDialogOpen: true,
      cancelEntryId: entry._id,
      cancelOptions,
      cancelSelectedIds: [],
      cancelCanConfirm: false
    });
  },

  closeCancelDialog() {
    this.setData({
      cancelDialogOpen: false,
      cancelEntryId: '',
      cancelOptions: [],
      cancelSelectedIds: [],
      cancelCanConfirm: false
    });
  },

  onCancelSelect(event) {
    const selectedIds = event.detail.value || [];
    this.setData({
      cancelSelectedIds: selectedIds,
      cancelCanConfirm: selectedIds.length === 2 || selectedIds.length === 4
    });
  },

  async confirmCancelSelection() {
    const selectedIds = this.data.cancelSelectedIds || [];
    if (!this.data.cancelCanConfirm) {
      return;
    }

    const confirmed = await this.confirmAction('取消排队', `确定取消选中的 ${selectedIds.length} 个账号吗？`);
    if (!confirmed) return;

    try {
      await this.callApi('cancelQueueEntry', {
        groupId: this.data.currentGroup._id,
        queueEntryId: this.data.cancelEntryId,
        cancelCredentialIds: selectedIds
      });
      this.closeCancelDialog();
      await this.refreshDashboard();
    } catch (error) {
      this.showError(error);
    }
  },

  confirmAction(title, content) {
    return new Promise((resolve) => {
      wx.showModal({
        title,
        content,
        confirmText: '确定',
        cancelText: '再想想',
        success: (result) => resolve(Boolean(result.confirm)),
        fail: () => resolve(false)
      });
    });
  }
});
