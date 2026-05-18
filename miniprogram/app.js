App({
  globalData: {
    cloudEnvId: 'wx3ed0db1771bb16e4'
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请使用 2.2.3 或以上基础库以支持云开发。',
        showCancel: false
      });
      return;
    }

    const options = {
      traceUser: true
    };

    if (this.globalData.cloudEnvId) {
      options.env = this.globalData.cloudEnvId;
    }

    wx.cloud.init(options);
  }
});
