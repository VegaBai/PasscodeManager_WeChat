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
    savingQueue: false,
    openid: '',
    groups: [],
    currentGroup: null,
    currentGroupIndex: 0,
    username: '',
    password: '',
    queueOpen: false,
    courtName: '',
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
    courtPreview: {
      nextGroupNo: 1,
      remainingMinutes: 0
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
        groups: result.groups || []
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
        groups: result.groups || []
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
        groups: result.groups || this.data.groups,
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
      queued: '排队'
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

    this.setData({
      sortedCredentials,
      idleCredentials,
      stats,
      courtPreview: this.buildCourtPreview()
    });
  },

  buildCourtPreview() {
    const courtName = String(this.data.courtName || '').trim();
    const nowTs = this.data.nowTs || Date.now();
    if (!courtName) {
      return {
        nextGroupNo: 1,
        remainingMinutes: 0
      };
    }

    const entries = (this.data.queueEntries || []).filter((entry) => entry.courtName === courtName);
    const playing = entries.find((entry) => entry.status === 'playing');
    const queued = entries.filter((entry) => entry.status === 'queued');

    return {
      nextGroupNo: (playing ? 1 : 0) + queued.length + 1,
      remainingMinutes: playing ? minutesUntil(playing.endAt, nowTs) : 0
    };
  },

  onUsernameInput(event) {
    this.setData({ username: event.detail.value });
  },

  onPasswordInput(event) {
    this.setData({ password: event.detail.value });
  },

  onCourtNameInput(event) {
    this.setData({ courtName: event.detail.value });
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

  async addQueueEntry() {
    const selectedIds = this.data.selectedIds || [];
    const courtName = String(this.data.courtName || '').trim();

    if (!courtName) {
      this.showError(new Error('请输入场地编号'));
      return;
    }
    if (!(selectedIds.length === 2 || selectedIds.length === 4)) {
      this.showError(new Error('请选择 2 个或 4 个账号'));
      return;
    }

    this.setData({ savingQueue: true });
    try {
      await this.callApi('addQueueEntry', {
        groupId: this.data.currentGroup._id,
        courtName,
        credentialIds: selectedIds
      });
      this.setData({
        selectedIds: [],
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

    try {
      await this.callApi('cancelQueueEntry', {
        groupId: this.data.currentGroup._id,
        queueEntryId: entryId
      });
      await this.refreshDashboard();
    } catch (error) {
      this.showError(error);
    }
  }
});
