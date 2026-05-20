App({
  globalData: {
    // 这里填云开发环境 ID，不是小程序 AppID。留空时使用开发者工具当前选中的云环境。
    cloudEnvId: '',
    enterOptions: null
  },

  onLaunch(launchOptions) {
    this.globalData.enterOptions = launchOptions;

    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请使用 2.2.3 或以上基础库以支持云开发。',
        showCancel: false
      });
      return;
    }

    const cloudOptions = {
      traceUser: true
    };

    if (this.globalData.cloudEnvId) {
      cloudOptions.env = this.globalData.cloudEnvId;
    }

    wx.cloud.init(cloudOptions);
  },

  onShow(options) {
    this.globalData.enterOptions = options;
  }
});
