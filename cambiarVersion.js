// ============================================================
  // ===== SISTEMA DE VERSIONES =====
  // ============================================================
  (function() {
    // --- Versión actual y changelog ---
    const APP_VERSION = '0.5';
    const CHANGELOG = [
      'La app ahora calienta menos el teléfono y gasta menos batería mientras compartes tu ubicación.',
      'Ahora hay que elegir tu ramal (Capilla/Secundaria) cada día antes de poder reportar checkpoints.',
      'Corregido: el panel de dueño/checador ya no se queda con avisos viejos — ya no hace falta refrescar para verlos.',
      'Corrección de errores menores.',
      'Se agrego personalizacion al conductor.'
    ];

    // --- Elementos ---
    const updateOverlay = document.getElementById('updateOverlay');
    const updateVersionDisplay = document.getElementById('updateVersionDisplay');
    const updateChangelog = document.getElementById('updateChangelog');
    const applyBtn = document.getElementById('applyUpdateBtn');
    const skipBtn = document.getElementById('skipUpdateBtn');
    const versionFooter = document.getElementById('versionFooter');

    // Mostrar la versión en el footer
    versionFooter.textContent = 'v' + APP_VERSION;

    function showUpdateModal() {
      updateVersionDisplay.textContent = 'v' + APP_VERSION;
      const list = updateChangelog.querySelector('ul');
      list.innerHTML = '';
      CHANGELOG.forEach(item => {
        const li = document.createElement('li');
        li.innerHTML = `<i data-lucide="check-circle-2" class="w-4 h-4 shrink-0"></i> ${item}`;
        list.appendChild(li);
      });
      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
      updateOverlay.classList.add('show');
    }

    function applyUpdate() {
      localStorage.setItem('app_version', APP_VERSION);
      window.location.reload(true);
    }

    function skipUpdate() {
      updateOverlay.classList.remove('show');
      localStorage.setItem('app_version', APP_VERSION);
    }

    function checkVersion() {
      const savedVersion = localStorage.getItem('app_version');
      // Si no hay versión guardada o es diferente, mostrar el modal
      if (savedVersion !== APP_VERSION) {
        showUpdateModal();
      }
    }

    applyBtn.addEventListener('click', applyUpdate);
    skipBtn.addEventListener('click', skipUpdate);
    updateOverlay.addEventListener('click', function(e) {
      if (e.target === updateOverlay) {
        skipUpdate();
      }
    });

    // Ejecutar al cargar
    setTimeout(checkVersion, 300);
  })();
