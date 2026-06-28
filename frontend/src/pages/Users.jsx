import { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'

const STATUS_CONFIG = {
  active:   { label: 'Active',   bg: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
  pending:  { label: 'Pending',  bg: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300' },
  inactive: { label: 'Inactive', bg: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' },
}

function GoalBar({ today, goal }) {
  const pct = Math.min((today / Math.max(goal, 1)) * 100, 100)
  const color = pct >= 100 ? 'bg-green-500' : pct >= 60 ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
        <span>{today} tickets</span>
        <span>Goal: {goal}</span>
      </div>
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
        <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function Users() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(null)
  const [editingGoal, setEditingGoal] = useState(null)
  const [goalInput, setGoalInput] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [fdEnabled, setFdEnabled] = useState(true)
  const [fdToggling, setFdToggling] = useState(false)

  const fetchUsers = async () => {
    try {
      const res = await client.get('/users/')
      setUsers(res.data)
    } catch {
      toast.error('Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUsers()
    client.get('/settings').then(r => {
      setFdEnabled(r.data?.freshdesk_on_generate !== 'false')
    }).catch(() => {})
  }, [])

  const cycleStatus = async (user) => {
    setActionLoading(`status-${user.id}`)
    try {
      const res = await client.patch(`/users/${user.id}/status`)
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, status: res.data.status } : u))
      const labels = { active: 'approved', inactive: 'deactivated', pending: 'reset to pending' }
      toast.success(`${user.username} ${labels[res.data.status] || res.data.status}`)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update status')
    } finally {
      setActionLoading(null)
    }
  }

  const startEditGoal = (user) => {
    setEditingGoal(user.id)
    setGoalInput(String(user.daily_goal))
  }

  const saveGoal = async (user) => {
    const goal = parseInt(goalInput)
    if (isNaN(goal) || goal < 1) { toast.error('Goal must be >= 1'); return }
    try {
      const res = await client.patch(`/users/${user.id}/goal`, { goal })
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, daily_goal: res.data.daily_goal } : u))
      toast.success(`Goal set to ${res.data.daily_goal}`)
    } catch {
      toast.error('Failed to update goal')
    } finally {
      setEditingGoal(null)
    }
  }

  const deleteUser = async (user) => {
    setActionLoading(`delete-${user.id}`)
    try {
      await client.delete(`/users/${user.id}`)
      setUsers(prev => prev.filter(u => u.id !== user.id))
      toast.success(`${user.username} deleted`)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete user')
    } finally {
      setActionLoading(null)
      setConfirmDelete(null)
    }
  }

  const toggleRole = async (user) => {
    setActionLoading(`role-${user.id}`)
    try {
      const res = await client.patch(`/users/${user.id}/role`)
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, role: res.data.role } : u))
      toast.success(`${user.username} is now ${res.data.role}`)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update role')
    } finally {
      setActionLoading(null)
    }
  }

  const toggleFd = async () => {
    setFdToggling(true)
    try {
      const newVal = !fdEnabled
      await client.patch('/settings/freshdesk_on_generate', { value: String(newVal) })
      setFdEnabled(newVal)
      toast.success(`Freshdesk fetch on Generate ${newVal ? 'enabled' : 'disabled'}`)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update setting')
    } finally {
      setFdToggling(false)
    }
  }

  const pendingCount = users.filter(u => u.status === 'pending').length

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </Layout>
    )
  }

  return (
    <Layout>
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 dark:text-white">User Management</h2>
            <p className="text-sm text-gray-500 mt-1">{users.length} users registered</p>
          </div>
          {pendingCount > 0 && (
            <div className="flex items-center space-x-2 px-4 py-2 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-700 rounded-lg">
              <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              <span className="text-sm font-medium text-yellow-800 dark:text-yellow-300">
                {pendingCount} pending approval
              </span>
            </div>
          )}
        </div>

        {/* App Settings */}
        <div className="mb-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-5">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">App Settings</h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-white">Freshdesk Fetch on Generate</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Allow agents to load tickets by ID/URL on the Generate page</p>
            </div>
            <button
              onClick={toggleFd}
              disabled={fdToggling}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${fdEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${fdEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        {/* User Cards */}
        <div className="space-y-4">
          {users.map(user => {
            const statusCfg = STATUS_CONFIG[user.status] || STATUS_CONFIG.active
            const isAdmin = user.role === 'admin'
            const busy = actionLoading === `status-${user.id}`
            const deleting = actionLoading === `delete-${user.id}`

            return (
              <div
                key={user.id}
                className={`bg-white dark:bg-gray-800 rounded-xl shadow-sm border transition-all ${
                  user.status === 'pending'
                    ? 'border-yellow-300 dark:border-yellow-700'
                    : user.status === 'inactive'
                    ? 'border-gray-200 dark:border-gray-700 opacity-70'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <div className="p-5 grid grid-cols-1 lg:grid-cols-4 gap-4 items-center">
                  {/* Identity */}
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center text-blue-700 dark:text-blue-300 font-bold text-sm flex-shrink-0">
                      {user.username.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900 dark:text-white truncate">{user.username}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</div>
                      <div className="flex items-center space-x-2 mt-1">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                          isAdmin ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300'
                                  : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                        }`}>{user.role}</span>
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusCfg.bg}`}>
                          {statusCfg.label}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Today / Goal progress */}
                  <div className="lg:col-span-1">
                    <div className="text-xs text-gray-400 dark:text-gray-500 mb-2 font-medium uppercase tracking-wide">Today's Progress</div>
                    <GoalBar today={user.tracked_today} goal={user.daily_goal} />
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Total tickets: <span className="font-medium text-gray-700 dark:text-gray-300">{user.ticket_count}</span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Bot usage: <span className="font-medium text-gray-700 dark:text-gray-300">${(user.monthly_cost || 0).toFixed(4)} this month</span>
                    </div>
                  </div>

                  {/* Goal editor */}
                  <div className="flex flex-col space-y-1">
                    <div className="text-xs text-gray-400 dark:text-gray-500 font-medium uppercase tracking-wide mb-1">Daily Goal</div>
                    {editingGoal === user.id ? (
                      <div className="flex items-center space-x-2">
                        <input
                          type="number" min="1" value={goalInput}
                          onChange={e => setGoalInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveGoal(user); if (e.key === 'Escape') setEditingGoal(null) }}
                          className="w-20 px-2 py-1 text-sm border border-blue-400 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                          autoFocus
                        />
                        <button onClick={() => saveGoal(user)} className="text-xs text-green-600 hover:text-green-800 font-medium">Save</button>
                        <button onClick={() => setEditingGoal(null)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEditGoal(user)}
                        className="flex items-center space-x-1 text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 group w-fit"
                      >
                        <span className="text-2xl font-bold">{user.daily_goal}</span>
                        <span className="text-gray-300 group-hover:text-blue-400 text-sm">✎</span>
                      </button>
                    )}
                    <div className="text-xs text-gray-400">Click to edit</div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center space-x-2 justify-end">
                    {/* Joined / Last login */}
                    <div className="text-xs text-gray-400 dark:text-gray-500 mr-auto space-y-0.5">
                      <div>Joined {new Date(user.created_at).toLocaleDateString()}</div>
                      <div>
                        Last login:{' '}
                        {user.last_login
                          ? new Date(user.last_login + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                          : <span className="italic text-gray-300 dark:text-gray-600">never</span>}
                      </div>
                    </div>

                    {user.username !== 'admin' && (
                      <button
                        onClick={() => toggleRole(user)}
                        disabled={actionLoading === `role-${user.id}`}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
                          isAdmin
                            ? 'bg-purple-50 text-purple-700 hover:bg-purple-100 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-700'
                            : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600'
                        }`}
                        title={isAdmin ? 'Revoke admin access' : 'Grant admin access'}
                      >
                        {actionLoading === `role-${user.id}` ? '...' : isAdmin ? 'Revoke Admin' : 'Make Admin'}
                      </button>
                    )}
                    {!isAdmin && (
                      <>
                        {/* Status cycle button */}
                        <button
                          onClick={() => cycleStatus(user)}
                          disabled={busy}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
                            user.status === 'pending'
                              ? 'bg-green-50 text-green-700 hover:bg-green-100 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-700'
                              : user.status === 'active'
                              ? 'bg-red-50 text-red-700 hover:bg-red-100 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-700'
                              : 'bg-green-50 text-green-700 hover:bg-green-100 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-700'
                          }`}
                        >
                          {busy ? '...' : user.status === 'pending' ? 'Approve' : user.status === 'active' ? 'Deactivate' : 'Reactivate'}
                        </button>

                        {/* Delete */}
                        {confirmDelete === user.id ? (
                          <div className="flex items-center space-x-1">
                            <span className="text-xs text-red-600 dark:text-red-400">Confirm?</span>
                            <button
                              onClick={() => deleteUser(user)}
                              disabled={deleting}
                              className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                            >
                              {deleting ? '...' : 'Yes'}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="px-2 py-1 text-xs bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(user.id)}
                            className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-200 dark:border-gray-600 text-gray-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                          >
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Layout>
  )
}
