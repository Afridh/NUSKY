'use strict';
// Shop TV setup: the photos in its slideshow, what the board says, and the link for the TV.
(function () {
  const { h, api, field, toast, fail, busy, confirmBox } = NJ;

  // Photos are resized in the browser first, so a phone photo uploads quickly and the TV stays smooth.
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1920 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`${file.name} could not be opened as a photo. Save it as a JPEG or PNG and try again.`));
      };
      img.src = url;
    });
  }

  NJ.pages['/tv'] = async (page) => {
    const [info, tv, pictures] = await Promise.all([api('GET', '/api/server-info'), api('GET', '/api/tv'), api('GET', '/api/tv/images')]);
    const frame = h('iframe', { class: 'tvframe', src: '/tv', title: 'Preview of the shop TV board' });
    // Opened on the server computer itself, the TV needs that computer's network address.
    // Opened through a website address (the hosted system), the TV uses that same address.
    const onServerPc = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const tvLinks = onServerPc ? info.urls.map((u) => `${u}/tv`) : [`${location.origin}/tv`];

    // ----- photos -----
    const IDLE = 'Click here to choose photos from this computer, or drag photos onto this box.';
    const thumbs = h('div', { class: 'thumbs' });
    const picker = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, class: 'hidden' });
    const zoneText = h('span', { text: IDLE });
    const zone = h('div', {
      class: 'dropzone', role: 'button', tabindex: '0', 'aria-label': 'Add photos to the TV',
      onclick: () => picker.click(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } },
      ondragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); zone.classList.remove('over'); addFiles([...e.dataTransfer.files]); },
    }, h('b', { text: 'Add photos' }), zoneText);
    let adding = false;

    function renderThumbs(list) {
      thumbs.replaceChildren(...(list.length
        ? list.map((p, i) => h('div', { class: 'thumb' }, h('img', { src: p.url, alt: `TV photo ${i + 1}`, loading: 'lazy' }),
          h('button', {
            class: 'btn icon', type: 'button', 'aria-label': `Remove photo ${i + 1}`,
            onclick: async () => {
              if (!(await confirmBox('Remove this photo from the TV?', 'Remove photo', true))) return;
              try {
                renderThumbs(await api('DELETE', `/api/tv/images/${p.id}`));
                toast('Photo removed from the TV', 'good');
              } catch (err) { fail(err); }
            },
          }, '✕')))
        : [h('div', { class: 'empty' }, 'No photos yet. Until you add some, the TV shows the shop emblem in the photo space.')]));
    }
    async function addFiles(files) {
      if (adding || !files.length) return;
      const photos = files.filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
      const skipped = files.length - photos.length;
      if (!photos.length) return toast('Those are not photos the TV can show. Use JPEG, PNG or WebP files (iPhone HEIC photos need saving as JPEG first).', 'bad');
      adding = true;
      zone.classList.add('busy');
      let done = 0;
      try {
        for (const file of photos) {
          zoneText.textContent = `Adding photo ${done + 1} of ${photos.length}…`;
          renderThumbs(await api('POST', '/api/tv/images', { data: await shrink(file) }));
          done += 1;
        }
        toast(`${done === 1 ? 'Photo' : `${done} photos`} added. ${done === 1 ? 'It is' : 'They are'} on the TV now.${skipped ? ` ${skipped} file${skipped === 1 ? ' was' : 's were'} skipped: not JPEG, PNG or WebP.` : ''}`, 'good');
      } catch (err) {
        fail(err);
      } finally {
        adding = false;
        zone.classList.remove('busy');
        zoneText.textContent = IDLE;
      }
    }
    picker.addEventListener('change', () => {
      const files = [...picker.files];
      picker.value = '';
      addFiles(files);
    });
    renderThumbs(pictures);

    // ----- wording -----
    // ----- design -----
    const DESIGNS = [
      ['royal', 'Royal gold', 'Black and gold with the photo beside the prices. Light sweeps over the karat tabs; prices count up.'],
      ['cinema', 'Cinema', 'Your photos fill the whole screen with slow camera moves; prices float over them in glass cards.'],
      ['exchange', 'Exchange', 'A trading-floor board: flipping digits, up and down arrows against the previous rate, a scrolling LED line.'],
      ['spotlight', 'Spotlight', 'One karat at a time, enormous, changing every few seconds over a blurred photo.'],
      ['boutique', 'Boutique', 'Light and elegant, like a catalogue page. Gold ornaments draw themselves; prices melt and settle.'],
      ['board', 'Classic board', 'No photo. Selling and buying prices right across the screen.'],
    ];
    let theme = tv.theme || 'royal';
    const designs = h('div', { class: 'designs' }, DESIGNS.map(([id, name, note]) => h('label', { class: `design ${id === theme ? 'on' : ''}` },
      h('input', {
        type: 'radio', name: 'tv-design', value: id, checked: id === theme,
        onchange: () => {
          theme = id;
          for (const d of designs.children) d.classList.toggle('on', d.querySelector('input').value === id);
          frame.src = `/tv?theme=${id}`;
        },
      }),
      h('span', { class: `swatch sw-${id}` }), h('b', { text: name }), h('small', { text: note }))));
    const demoLinks = h('p', { class: 'small muted' }, 'To show a design on the TV without changing the setting, open: ',
      DESIGNS.map(([id, name], i) => [i ? ', ' : '', h('a', { href: `/tv?theme=${id}`, target: '_blank', rel: 'noopener', text: name })]));

    const subtitle = h('input', { type: 'text', maxlength: 80, value: tv.subtitle || '', placeholder: 'For example: Colombo 03' });
    const message = h('input', { type: 'text', maxlength: 300, value: tv.message || '' });
    const unit = h('select', { value: tv.show_pavan ? 'pavan' : 'gram' },
      h('option', { value: 'gram', text: 'Per gram' }), h('option', { value: 'pavan', text: 'Per pavan (8 grams)' }));
    const showBuy = h('input', { type: 'checkbox', checked: tv.show_buy });
    const points = [0, 1, 2].map((i) => {
      const p = (tv.points && tv.points[i]) || ['', ''];
      return [h('input', { type: 'text', maxlength: 30, value: p[0], 'aria-label': `Selling point ${i + 1} heading`, placeholder: 'Heading' }),
        h('input', { type: 'text', maxlength: 50, value: p[1], 'aria-label': `Selling point ${i + 1} detail`, placeholder: 'Detail' })];
    });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Update the TV');
    save.addEventListener('click', busy(save, async () => {
      await api('PUT', '/api/tv', {
        subtitle: subtitle.value, message: message.value, show_pavan: unit.value === 'pavan', show_buy: showBuy.checked,
        theme,
        points: points.map(([a, b]) => [a.value, b.value]),
      });
      frame.src = '/tv';
      toast('The TV is showing your changes', 'good');
    }));

    page.append(h('div', { class: 'cols' },
      h('div', null,
        h('div', { class: 'panel' }, h('h2', { text: 'Photos on the TV' }),
          h('p', { class: 'muted small', text: 'Photos of your jewellery. The TV shows them one after another in the large space beside the prices. Wide (landscape) photos fit best. Up to 20.' }),
          zone, picker, thumbs),
        h('div', { class: 'panel' }, h('h2', { text: 'Design' }),
          h('p', { class: 'muted small', text: 'Pick one and the preview changes at once. Press "Update the TV" below to put it on the TV.' }),
          designs, demoLinks),
        h('div', { class: 'panel' }, h('h2', { text: 'What the TV says' }),
          field('Line under the shop name', subtitle, 'Usually the town or branch. Leave empty to hide it.'),
          h('div', { class: 'row' }, field('Show prices', unit), h('label', { class: 'check', style: 'margin-bottom:1.2em' }, showBuy, h('span', null, 'Also show our buying price'))),
          h('div', { class: 'field' }, h('span', { text: 'Three selling points along the bottom' }),
            points.map(([a, b]) => h('div', { class: 'row', style: 'margin-bottom:.4rem' }, a, b)),
            h('small', { text: 'A fourth box shows "Contact us" with the shop phone number from Settings.' })),
          field('Scrolling offer line', message, 'For example: Special offer on 22K jewellery this week. Leave empty to hide it.'),
          save)),
      h('div', null,
        h('div', { class: 'panel' }, h('h2', { text: 'Preview' }), frame,
          h('p', { class: 'muted small', style: 'margin:.6rem 0 0', text: 'This is the TV, live. Photos and wording you change here appear on it straight away.' })),
        h('div', { class: 'panel' }, h('h2', { text: 'Link for the TV' }),
          tvLinks.length
            ? [tvLinks.map((u) => h('p', { class: 'tvlink', text: u })),
              h('ol', null,
                h('li', null, onServerPc ? 'Connect the smart TV to the same Wi-Fi or router as this server computer.' : 'Connect the smart TV to the internet.'),
                h('li', null, 'Open the web browser on the TV.'),
                h('li', null, 'Type the address above and press OK. Bookmark it so it is one click next time.'),
                h('li', null, 'Leave it open. Prices change on the TV by themselves whenever you update the rates.')),
              tvLinks.length > 1 ? h('p', { class: 'muted small', text: 'More than one address is listed because this computer has more than one network connection. Use the one that works on the TV.' }) : null]
            : h('div', { class: 'notice bad', text: 'This server computer is not connected to a network. Connect it to the shop Wi-Fi or router, then reload this page to see the link.' }),
          h('p', null, h('a', { href: '/tv', target: '_blank', rel: 'noopener' }, 'Open the TV board in a new tab'))))));
  };
})();
