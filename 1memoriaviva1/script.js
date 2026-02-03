(function(){
  const btn = document.querySelector('[data-menu]');
  const links = document.querySelector('[data-links]');

  if(btn && links){
    btn.addEventListener('click', () => {
      links.classList.toggle('show');
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
    });
  }

  const yearEl = document.getElementById('year');
  if(yearEl) yearEl.textContent = new Date().getFullYear();

  const form = document.querySelector('#contactForm');
  if(form){
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = form.querySelector('#name').value.trim();
      const email = form.querySelector('#email').value.trim();
      const msg = form.querySelector('#message').value.trim();

      if(!name || !email || !msg){
        alert('Por favor, preencha nome, e-mail e mensagem.');
        return;
      }

      alert('Mensagem enviada! (Simulação)\\n\\nSe você quiser, eu posso integrar esse formulário com um serviço real (ex.: Formspree/Netlify) ou WhatsApp.');
      form.reset();
    });
  }
})();