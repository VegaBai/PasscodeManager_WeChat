const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;
const ROUND_MINUTES = 45;
const ALNUM = /^[A-Za-z0-9]+$/;

function ok(data = {}) {
  return {
    ok: true,
    data
  };
}

function fail(message) {
  return {
    ok: false,
    message
  };
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

async function ensureUser(openid) {
  const existing = await db.collection('users').where({ openid }).limit(1).get();
  const now = new Date();

  if (existing.data.length) {
    await db.collection('users').doc(existing.data[0]._id).update({
      data: {
        lastSeenAt: now
      }
    });
    return existing.data[0];
  }

  const created = await db.collection('users').add({
    data: {
      openid,
      createdAt: now,
      lastSeenAt: now
    }
  });

  return {
    _id: created._id,
    openid
  };
}

async function listGroups(openid) {
  const result = await db.collection('groups')
    .where({
      memberOpenids: _.all([openid])
    })
    .orderBy('createdAt', 'desc')
    .get();
  return result.data;
}

async function getDoc(collectionName, id) {
  try {
    const result = await db.collection(collectionName).doc(id).get();
    return result.data;
  } catch (error) {
    return null;
  }
}

async function requireGroupMember(groupId, openid) {
  if (!groupId) throw new Error('缺少群 ID');
  const group = await getDoc('groups', groupId);
  if (!group) throw new Error('球群不存在');
  if (!Array.isArray(group.memberOpenids) || !group.memberOpenids.includes(openid)) {
    throw new Error('你不是该球群成员');
  }
  return group;
}

async function logOperation(openid, groupId, action, detail) {
  await db.collection('operationLogs').add({
    data: {
      groupId,
      operatorOpenid: openid,
      action,
      detail,
      createdAt: new Date()
    }
  });
}

async function finishEntry(entry, endedAt) {
  await db.collection('queueEntries').doc(entry._id).update({
    data: {
      status: 'finished',
      actualEndAt: endedAt,
      updatedAt: endedAt
    }
  });

  await db.collection('credentials').where({
    _id: _.in(entry.credentialIds || [])
  }).update({
    data: {
      status: 'idle',
      currentCourtName: '',
      currentQueueEntryId: '',
      availableAt: endedAt,
      updatedAt: endedAt
    }
  });
}

async function setEntryPlaying(entry, startAt) {
  const endAt = addMinutes(startAt, ROUND_MINUTES);

  await db.collection('queueEntries').doc(entry._id).update({
    data: {
      status: 'playing',
      groupNo: 1,
      startAt,
      endAt,
      updatedAt: startAt
    }
  });

  await db.collection('credentials').where({
    _id: _.in(entry.credentialIds || [])
  }).update({
    data: {
      status: 'playing',
      currentCourtName: entry.courtName,
      currentQueueEntryId: entry._id,
      availableAt: endAt,
      updatedAt: startAt
    }
  });

  return {
    ...entry,
    status: 'playing',
    groupNo: 1,
    startAt,
    endAt
  };
}

async function rescheduleCourt(groupId, courtName) {
  const now = new Date();

  const playingResult = await db.collection('queueEntries')
    .where({
      groupId,
      courtName,
      status: 'playing'
    })
    .orderBy('startAt', 'asc')
    .get();

  let playing = playingResult.data.find((entry) => {
    return !entry.endAt || new Date(entry.endAt).getTime() > now.getTime();
  }) || null;

  const queuedResult = await db.collection('queueEntries')
    .where({
      groupId,
      courtName,
      status: 'queued'
    })
    .orderBy('createdAt', 'asc')
    .get();

  const queued = queuedResult.data;

  if (!playing && queued.length) {
    playing = await setEntryPlaying(queued.shift(), now);
  }

  let cursor = playing ? new Date(playing.endAt) : now;
  let groupNo = playing ? 2 : 1;

  for (const entry of queued) {
    const startAt = cursor;
    const endAt = addMinutes(startAt, ROUND_MINUTES);
    await db.collection('queueEntries').doc(entry._id).update({
      data: {
        groupNo,
        startAt,
        endAt,
        updatedAt: now
      }
    });

    await db.collection('credentials').where({
      _id: _.in(entry.credentialIds || [])
    }).update({
      data: {
        currentCourtName: courtName,
        currentQueueEntryId: entry._id,
        availableAt: endAt,
        updatedAt: now
      }
    });

    cursor = endAt;
    groupNo += 1;
  }
}

async function advanceExpired() {
  const now = new Date();
  const expiredResult = await db.collection('queueEntries')
    .where({
      status: 'playing',
      endAt: _.lte(now)
    })
    .get();

  const touchedCourts = new Set();

  for (const entry of expiredResult.data) {
    await finishEntry(entry, now);
    touchedCourts.add(`${entry.groupId}::${entry.courtName}`);
  }

  for (const key of touchedCourts) {
    const [groupId, courtName] = key.split('::');
    await rescheduleCourt(groupId, courtName);
  }

  return {
    advanced: expiredResult.data.length
  };
}

async function init(openid) {
  await ensureUser(openid);
  await advanceExpired();
  return {
    openid,
    groups: await listGroups(openid)
  };
}

async function createGroup(openid, payload) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('请输入群名称');

  const now = new Date();
  const created = await db.collection('groups').add({
    data: {
      name,
      ownerOpenid: openid,
      memberOpenids: [openid],
      createdAt: now,
      updatedAt: now
    }
  });

  await logOperation(openid, created._id, 'createGroup', { name });

  return {
    groupId: created._id,
    groups: await listGroups(openid)
  };
}

async function joinGroup(openid, payload) {
  const groupId = String(payload.groupId || '').trim();
  const group = await getDoc('groups', groupId);
  if (!group) throw new Error('球群不存在');

  await db.collection('groups').doc(groupId).update({
    data: {
      memberOpenids: _.addToSet(openid),
      updatedAt: new Date()
    }
  });

  await logOperation(openid, groupId, 'joinGroup', {});

  return {
    groupId,
    groups: await listGroups(openid)
  };
}

async function getDashboard(openid, payload) {
  const group = await requireGroupMember(payload.groupId, openid);
  await advanceExpired();

  const credentialsResult = await db.collection('credentials')
    .where({
      groupId: payload.groupId,
      deletedAt: _.exists(false)
    })
    .orderBy('createdAt', 'desc')
    .get();

  const queueResult = await db.collection('queueEntries')
    .where({
      groupId: payload.groupId,
      status: _.in(['playing', 'queued'])
    })
    .orderBy('createdAt', 'asc')
    .get();

  return {
    currentGroup: group,
    groups: await listGroups(openid),
    credentials: credentialsResult.data,
    queueEntries: queueResult.data,
    now: new Date()
  };
}

async function addCredential(openid, payload) {
  const groupId = payload.groupId;
  await requireGroupMember(groupId, openid);

  const username = String(payload.username || '').trim();
  const password = String(payload.password || '').trim();

  if (!ALNUM.test(username) || !ALNUM.test(password)) {
    throw new Error('用户名和密码只能包含英文或数字');
  }

  const duplicate = await db.collection('credentials')
    .where({
      groupId,
      username,
      deletedAt: _.exists(false)
    })
    .limit(1)
    .get();

  if (duplicate.data.length) throw new Error('这个用户名已经存在');

  const now = new Date();
  const created = await db.collection('credentials').add({
    data: {
      groupId,
      username,
      password,
      status: 'idle',
      currentCourtName: '',
      currentQueueEntryId: '',
      createdByOpenid: openid,
      createdAt: now,
      updatedAt: now
    }
  });

  await logOperation(openid, groupId, 'addCredential', {
    credentialId: created._id,
    username
  });

  return {
    credentialId: created._id
  };
}

async function deleteCredential(openid, payload) {
  const groupId = payload.groupId;
  await requireGroupMember(groupId, openid);

  const credential = await getDoc('credentials', payload.credentialId);
  if (!credential || credential.groupId !== groupId || credential.deletedAt) {
    throw new Error('账号不存在');
  }
  if (credential.createdByOpenid !== openid) {
    throw new Error('只能删除自己添加的账号');
  }
  if (credential.status !== 'idle') {
    throw new Error('排队或正在打的账号不能删除');
  }

  const now = new Date();
  await db.collection('credentials').doc(payload.credentialId).update({
    data: {
      deletedAt: now,
      updatedAt: now
    }
  });

  await logOperation(openid, groupId, 'deleteCredential', {
    credentialId: payload.credentialId
  });

  return {};
}

async function addQueueEntry(openid, payload) {
  const groupId = payload.groupId;
  await requireGroupMember(groupId, openid);

  const courtName = String(payload.courtName || '').trim();
  const credentialIds = Array.isArray(payload.credentialIds) ? payload.credentialIds : [];

  if (!courtName) throw new Error('请输入场地编号');
  if (!(credentialIds.length === 2 || credentialIds.length === 4)) {
    throw new Error('每组必须选择 2 个或 4 个账号');
  }
  if (new Set(credentialIds).size !== credentialIds.length) {
    throw new Error('不能重复选择账号');
  }

  await advanceExpired();

  const credentialsResult = await db.collection('credentials')
    .where({
      _id: _.in(credentialIds),
      groupId,
      deletedAt: _.exists(false)
    })
    .get();

  if (credentialsResult.data.length !== credentialIds.length) {
    throw new Error('账号数据不完整');
  }

  const blocked = credentialsResult.data.find((item) => item.status !== 'idle');
  if (blocked) throw new Error(`${blocked.username} 不是空闲状态`);

  const activeResult = await db.collection('queueEntries')
    .where({
      groupId,
      courtName,
      status: _.in(['playing', 'queued'])
    })
    .orderBy('createdAt', 'asc')
    .get();

  const now = new Date();
  const hasPlaying = activeResult.data.some((entry) => entry.status === 'playing');
  const status = hasPlaying || activeResult.data.length ? 'queued' : 'playing';
  const latestEnd = activeResult.data.reduce((latest, entry) => {
    const endAt = entry.endAt ? new Date(entry.endAt) : now;
    return endAt.getTime() > latest.getTime() ? endAt : latest;
  }, now);
  const startAt = status === 'playing' ? now : latestEnd;
  const endAt = addMinutes(startAt, ROUND_MINUTES);
  const groupNo = status === 'playing' ? 1 : activeResult.data.length + 1;

  const created = await db.collection('queueEntries').add({
    data: {
      groupId,
      courtName,
      credentialIds,
      status,
      groupNo,
      createdByOpenid: openid,
      startAt,
      endAt,
      createdAt: now,
      updatedAt: now
    }
  });

  await db.collection('credentials').where({
    _id: _.in(credentialIds)
  }).update({
    data: {
      status,
      currentCourtName: courtName,
      currentQueueEntryId: created._id,
      availableAt: endAt,
      updatedAt: now
    }
  });

  await db.collection('courts').where({
    groupId,
    name: courtName
  }).count().then(async (countResult) => {
    if (!countResult.total) {
      await db.collection('courts').add({
        data: {
          groupId,
          name: courtName,
          createdAt: now,
          updatedAt: now
        }
      });
    }
  });

  await rescheduleCourt(groupId, courtName);
  await logOperation(openid, groupId, 'addQueueEntry', {
    queueEntryId: created._id,
    courtName,
    credentialIds
  });

  return {
    queueEntryId: created._id
  };
}

async function cancelQueueEntry(openid, payload) {
  const groupId = payload.groupId;
  await requireGroupMember(groupId, openid);

  const entry = await getDoc('queueEntries', payload.queueEntryId);
  if (!entry || entry.groupId !== groupId) throw new Error('排队记录不存在');
  if (!['playing', 'queued'].includes(entry.status)) {
    throw new Error('这条记录已经结束');
  }

  const now = new Date();
  await db.collection('queueEntries').doc(entry._id).update({
    data: {
      status: 'cancelled',
      cancelledByOpenid: openid,
      cancelledAt: now,
      updatedAt: now
    }
  });

  await db.collection('credentials').where({
    _id: _.in(entry.credentialIds || [])
  }).update({
    data: {
      status: 'idle',
      currentCourtName: '',
      currentQueueEntryId: '',
      availableAt: now,
      updatedAt: now
    }
  });

  await rescheduleCourt(groupId, entry.courtName);
  await logOperation(openid, groupId, 'cancelQueueEntry', {
    queueEntryId: entry._id,
    courtName: entry.courtName
  });

  return {};
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const action = event.action || (event.TriggerName ? 'advanceExpired' : '');
  const payload = event.payload || {};

  try {
    const actions = {
      init,
      createGroup,
      joinGroup,
      getDashboard,
      addCredential,
      deleteCredential,
      addQueueEntry,
      cancelQueueEntry,
      advanceExpired: async () => advanceExpired()
    };

    if (!actions[action]) return fail('未知操作');
    const data = await actions[action](openid, payload);
    return ok(data);
  } catch (error) {
    return fail(error.message || '操作失败');
  }
};
