var gameConfigPromise = fetch('/api/game-config')
  .then(function(response) {
    if (!response.ok) throw new Error('Unable to load game config');
    return response.json();
  })
  .catch(function() {
    return {
      commitDuration: null,
      revealDuration: null,
      turnstileSiteKey: null,
    };
  });

(function() {
  var nav = document.getElementById('mainNav');
  var button = document.getElementById('navHamburger');
  var mobileLinks = document.querySelectorAll('.nav-mobile a');

  if (!nav || !button) return;

  button.addEventListener('click', function() {
    var open = nav.classList.toggle('menu-open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  mobileLinks.forEach(function(link) {
    link.addEventListener('click', function() {
      nav.classList.remove('menu-open');
      button.setAttribute('aria-expanded', 'false');
    });
  });
})();

(function() {
  var nodes = document.querySelectorAll('.reveal');
  if (!nodes.length) return;

  if (!('IntersectionObserver' in window)) {
    nodes.forEach(function(node) {
      node.classList.add('is-visible');
    });
    return;
  }

  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.15 });

  nodes.forEach(function(node) {
    observer.observe(node);
  });
})();

(function() {
  var shell = document.querySelector('.example-shell');
  var grid = document.getElementById('exampleGrid');
  var options = document.querySelectorAll('.example-opt');
  var insight = document.querySelector('.example-insight p');
  var status = document.querySelector('.example-vote-status');
  var turnstileContainer = document.getElementById('example-turnstile');
  var resetButton = document.getElementById('exReset');
  var widgetId = null;
  var widgetInitPromise = null;
  var pendingChallenge = null;
  var siteKey = null;

  if (!shell || !grid || !options.length || !insight || !status || !turnstileContainer) {
    return;
  }

  options.forEach(function(option) {
    var bar = document.createElement('div');
    var pct = document.createElement('div');
    bar.className = 'vote-bar';
    pct.className = 'vote-pct';
    option.appendChild(bar);
    option.appendChild(pct);
  });

  function setStatus(message, tone) {
    status.textContent = message || '';
    status.classList.remove('pending', 'error', 'success');
    if (tone) status.classList.add(tone);
  }

  function setDisabled(disabled) {
    shell.classList.toggle('demo-disabled', disabled);
    options.forEach(function(option) {
      option.classList.toggle('disabled', disabled);
      option.disabled = disabled;
    });
  }

  function rejectPendingChallenge(message) {
    if (!pendingChallenge) return;
    var current = pendingChallenge;
    pendingChallenge = null;
    current.reject(new Error(message));
  }

  function resetTurnstileWidget() {
    pendingChallenge = null;
    if (window.turnstile && widgetId !== null) {
      window.turnstile.reset(widgetId);
    }
  }

  function waitForTurnstileReady() {
    return new Promise(function(resolve, reject) {
      var startedAt = Date.now();

      function check() {
        if (window.turnstile && typeof window.turnstile.render === 'function') {
          resolve(window.turnstile);
          return;
        }
        if (Date.now() - startedAt > 5000) {
          reject(new Error('Human verification failed to load. Please try again.'));
          return;
        }
        setTimeout(check, 50);
      }

      check();
    });
  }

  function ensureTurnstileWidget() {
    if (!siteKey) {
      return Promise.reject(new Error('Demo voting is temporarily unavailable.'));
    }
    if (widgetId !== null) {
      turnstileContainer.hidden = false;
      return Promise.resolve(widgetId);
    }
    if (widgetInitPromise) return widgetInitPromise;

    turnstileContainer.hidden = false;
    widgetInitPromise = waitForTurnstileReady()
      .then(function(turnstile) {
        widgetId = turnstile.render(turnstileContainer, {
          sitekey: siteKey,
          action: 'landing_example_vote',
          appearance: 'interaction-only',
          execution: 'execute',
          callback: function(token) {
            if (!pendingChallenge) return;
            var current = pendingChallenge;
            pendingChallenge = null;
            current.resolve(token);
          },
          'error-callback': function() {
            rejectPendingChallenge('Human verification failed. Please try again.');
          },
          'expired-callback': function() {
            rejectPendingChallenge('Verification expired. Please try again.');
          },
          'timeout-callback': function() {
            rejectPendingChallenge('Verification timed out. Please try again.');
          },
        });
        return widgetId;
      })
      .catch(function(error) {
        widgetInitPromise = null;
        turnstileContainer.hidden = true;
        throw error;
      });

    return widgetInitPromise;
  }

  function runTurnstileChallenge() {
    return ensureTurnstileWidget().then(function(id) {
      return new Promise(function(resolve, reject) {
        pendingChallenge = { resolve: resolve, reject: reject };
        try {
          window.turnstile.execute(id);
        } catch (error) {
          pendingChallenge = null;
          reject(
            error instanceof Error
              ? error
              : new Error('Human verification failed. Please try again.'),
          );
        }
      });
    });
  }

  function submitExampleVote(index, token) {
    return fetch('/api/example-vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionIndex: index, turnstileToken: token }),
    }).then(function(response) {
      if (response.ok) return response.json();

      return response.json()
        .catch(function() {
          return {};
        })
        .then(function(body) {
          var message = body && body.error ? body.error : 'Unable to record vote right now.';
          throw new Error(message);
        });
    });
  }

  function renderTally(data) {
    if (!data || !data.total) return;

    var counts = {};
    var maxCount = 0;

    data.votes.forEach(function(vote) {
      counts[vote.optionIndex] = vote.count;
      if (vote.count > maxCount) maxCount = vote.count;
    });

    options.forEach(function(option, index) {
      var count = counts[index] || 0;
      var pct = data.total > 0 ? Math.round((count / data.total) * 100) : 0;
      var pctNode = option.querySelector('.vote-pct');
      var barNode = option.querySelector('.vote-bar');
      pctNode.textContent = pct > 0 ? pct + '%' : '';
      if (barNode) {
        barNode.style.height = (maxCount > 0 ? Math.round((count / maxCount) * 100) : 0) + '%';
      }
    });

    grid.classList.add('revealed');
    insight.textContent = "100 is the only non-prime, the only round number, and the only three-digit number in the set. That salience makes it the natural coordination target: the focal point.";
  }

  function revealWithTally() {
    fetch('/api/example-tally')
      .then(function(response) { return response.json(); })
      .then(renderTally)
      .catch(function() {});
  }

  function resetExample() {
    localStorage.removeItem('example-voted');
    setStatus('', '');
    grid.classList.remove('revealed');
    options.forEach(function(option) {
      option.classList.remove('my-pick');
      option.classList.remove('disabled');
      option.disabled = false;
      var pctNode = option.querySelector('.vote-pct');
      var barNode = option.querySelector('.vote-bar');
      if (pctNode) pctNode.textContent = '';
      if (barNode) barNode.style.height = '0';
    });
    resetTurnstileWidget();
    turnstileContainer.hidden = true;
    insight.textContent = "100 is the only non-prime, the only round number, and the only three-digit number in the set. That salience makes it the natural coordination target: the focal point.";
  }

  if (resetButton) {
    resetButton.addEventListener('click', function() {
      resetExample();
    });
  }

  var votedIndex = localStorage.getItem('example-voted');
  if (votedIndex !== null) {
    var restored = parseInt(votedIndex, 10);
    if (!Number.isNaN(restored) && options[restored]) {
      options[restored].classList.add('my-pick');
      revealWithTally();
    }
  } else {
    options.forEach(function(option, index) {
      option.addEventListener('click', function() {
        if (grid.classList.contains('revealed')) return;

        setDisabled(true);
        setStatus('Verifying that you are human...', 'pending');

        runTurnstileChallenge()
          .then(function(token) {
            setStatus('Submitting your vote...', 'pending');
            return submitExampleVote(index, token);
          })
          .then(function() {
            localStorage.setItem('example-voted', String(index));
            option.classList.add('my-pick');
            setStatus('Vote recorded. Loading the crowd readout...', 'success');
            revealWithTally();
          })
          .catch(function(error) {
            setStatus(error instanceof Error ? error.message : 'Unable to record vote right now.', 'error');
            resetTurnstileWidget();
          })
          .finally(function() {
            setDisabled(false);
          });
      });
    });
  }

  gameConfigPromise.then(function(cfg) {
    siteKey = cfg && typeof cfg.turnstileSiteKey === 'string' && cfg.turnstileSiteKey.trim()
      ? cfg.turnstileSiteKey.trim()
      : null;
  });
})();

(function() {
  fetch('/api/landing-stats')
    .then(function(response) { return response.json(); })
    .then(function(data) {
      if (!data) return;
      if (data.playersLast24h != null) {
        document.getElementById('stat-players-24h').textContent = Number(data.playersLast24h).toLocaleString();
      }
      if (data.completedMatches != null) {
        document.getElementById('stat-completed-matches').textContent = Number(data.completedMatches).toLocaleString();
      }
      if (data.longestStreak != null) {
        document.getElementById('stat-longest-streak').textContent = Number(data.longestStreak).toLocaleString();
      }
    })
    .catch(function() {});
})();
