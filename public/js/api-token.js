/* eslint-env browser */
'use strict'

// Served as a plain static script by public/views/api-token.ejs, outside the webpack bundles.
;(function () {
  var page = document.getElementById('api-token-page')
  var data = page.dataset
  var list = document.getElementById('api-token-list')
  var errorBox = document.getElementById('api-token-error')

  function localizeTimes (root) {
    root.querySelectorAll('time[datetime]').forEach(function (el) {
      el.textContent = new Date(el.getAttribute('datetime')).toLocaleString()
    })
  }

  function showError (message) {
    errorBox.textContent = message || data.requestFailed
    errorBox.style.display = ''
  }

  function request (method, path, body) {
    var options = {
      method: method,
      credentials: 'same-origin',
      headers: { 'CSRF-Token': data.csrfToken }
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
    return fetch(data.serverUrl + path, options).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (json) {
        if (!res.ok) throw new Error(json.message || data.requestFailed)
        return json
      })
    })
  }

  function cell (row, content) {
    var td = document.createElement('td')
    if (content) td.appendChild(content)
    row.appendChild(td)
    return td
  }

  function text (value) {
    return document.createTextNode(value)
  }

  function renderRow (token) {
    var row = document.createElement('tr')
    row.dataset.id = token.id
    cell(row, text(token.name))
    var code = document.createElement('code')
    code.textContent = token.prefix + '…'
    cell(row, code)
    var created = document.createElement('time')
    created.setAttribute('datetime', token.createdAt)
    cell(row, created)
    cell(row, text(data.neverUsed))
    var revoke = document.createElement('button')
    revoke.type = 'button'
    revoke.className = 'btn btn-xs btn-danger api-token-revoke'
    revoke.textContent = data.revokeLabel
    cell(row, revoke)
    localizeTimes(row)
    return row
  }

  document.getElementById('api-token-create').addEventListener('submit', function (event) {
    event.preventDefault()
    errorBox.style.display = 'none'
    var nameInput = document.getElementById('api-token-name')
    request('POST', '/api/tokens', { name: nameInput.value }).then(function (json) {
      var valueInput = document.getElementById('api-token-value')
      valueInput.value = json.token
      document.getElementById('api-token-created').style.display = ''
      valueInput.select()
      list.insertBefore(renderRow(json.apiToken), list.firstChild)
      nameInput.value = ''
    }).catch(function (err) {
      showError(err.message)
    })
  })

  list.addEventListener('click', function (event) {
    var button = event.target.closest('.api-token-revoke')
    if (!button) return
    if (!window.confirm(data.confirmRevoke)) return
    var row = button.closest('tr')
    errorBox.style.display = 'none'
    request('DELETE', '/api/tokens/' + encodeURIComponent(row.dataset.id)).then(function () {
      row.parentNode.removeChild(row)
    }).catch(function (err) {
      showError(err.message)
    })
  })

  localizeTimes(list)
})()
