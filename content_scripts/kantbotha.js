if (typeof browser === 'undefined') globalThis.browser = chrome;

const verbose = false;
console.log('pmhaf -3');
/**** HIDE PRIVATE MESSAGES ****/

async function toggleHidePrivateMessages() {
  return browser.runtime.sendMessage({
    action: 'toggle_hide_private_messages'
  });
}

class PrivateMessagesHiderSidepanel {
  constructor(sidepanel) {
    this.rootElement = sidepanel.querySelector('.inner-view-region');
    this.observer = new MutationObserver(this.handleSidepanelMutation.bind(this));
    this.observer.observe(this.rootElement, { childList: true });
  }

  async handleSidepanelMutation(mutations, observer) {
    console.log('Handling sidepanel mutation');
    if (this.getSidepanelToggleButton()) return;

    let postListRegion = this.rootElement.querySelector('.post-list-region');
    while (!postListRegion) {
      await new Promise(resolve => setTimeout(resolve, 100));
      postListRegion = this.rootElement.querySelector('.post-list-region');
    }

    this.addToggleButton(postListRegion);
  }

  addToggleButton(postListRegion) {
    console.log('addToggleButton');
    if (this.getSidepanelToggleButton()) return;
    let toggleButton = document.createElement('button');
    toggleButton.id = 'toggle-hide-private-messages-button';
    toggleButton.textContent = 'Hide Private Messages';
    toggleButton.addEventListener('click', this.toggleHidePrivateMessages.bind(this));
    postListRegion.parentElement.insertBefore(toggleButton, postListRegion);
  }

  toggleHidePrivateMessages() {
    console.log('toggleHidePrivateMessages');
  }

  getSidepanelToggleButton() {
    let toggleButton = this.rootElement.querySelector('#toggle-hide-private-messages-button');
    if (toggleButton) return;
  }
}

function createPrivateMessageToggleActivityFeed() {
  let rootElement = document.querySelector('.event-menus');
  if (!rootElement) return;

  let toggle = document.createElement('div');
  toggle.classList.add('menu','hide-private-messages-toggle');
  toggle.innerHTML = `
    <div class="${rootElement.querySelector('.header-dropdown-container').className}">
      MODE:
      <div class="${rootElement.querySelector('.dropdown-display').className}">
        <div class="label"></div>
      </div>
    </div>
  `;
  toggle.addEventListener('click', toggleHidePrivateMessages);
  try {
    rootElement.insertBefore(toggle, rootElement.firstElementChild);
  } catch (e) {
    console.error('pmhaf', e);
  }
}

/**** RESIZE SIDE PANEL ****/

class ResizeHelper {
  constructor(element, resizeBarElement) {
    this.element = element;
    this.resizing = false;
    this.boundHandleMouseMove = this.handleMouseMove.bind(this);
    this.boundDoAnimationFrame = this.doAnimationFrame.bind(this);

    // Use this element to block other mouse events from interfering with the resize
    this.mouseUpBlockerElement = document.createElement('div');
    this.mouseUpBlockerElement.style.setProperty('position', 'fixed');
    this.mouseUpBlockerElement.style.setProperty('top', '0');
    this.mouseUpBlockerElement.style.setProperty('left', '0');
    this.mouseUpBlockerElement.style.setProperty('width', '100vw');
    this.mouseUpBlockerElement.style.setProperty('height', '100vh');
    this.mouseUpBlockerElement.style.setProperty('z-index', `9999999999999`);
    this.mouseUpBlockerElement.style.setProperty('opacity', '0');
    this.mouseUpBlockerElement.style.setProperty('display', 'none');

    document.body.appendChild(this.mouseUpBlockerElement);

    resizeBarElement.addEventListener('mousedown', this.handleMouseDown.bind(this));
    window.addEventListener('mouseup', this.handleMouseUp.bind(this));
  }

  handleMouseDown(event) {
    if (verbose) console.log('handleMouseDown');
    event.preventDefault();
    event.stopPropagation();

    this.clientX = event.clientX;
    this.newClientX = event.clientX;
    this.resizing = true;
    this.mouseUpBlockerElement.style.setProperty('display', 'block');
    window.addEventListener('mousemove', this.boundHandleMouseMove);
    window.requestAnimationFrame(this.boundDoAnimationFrame);
  }

  handleMouseUp(event) {
    if (verbose) console.log('handleMouseUp');
    if (!this.resizing) return;

    event.preventDefault();
    event.stopPropagation();

    this.resizing = false;
    window.removeEventListener('mousemove', this.boundHandleMouseMove);
    this.clientX = null;
    this.mouseUpBlockerElement.style.setProperty('display', 'none');
  }

  handleMouseMove(event) {
    if (verbose) console.log('handleMouseMove');
    event.preventDefault();
    event.stopPropagation();

    this.newClientX = event.clientX;
  }

  doResize() {
    if (verbose) console.log('doResize');
    const newClientX = this.newClientX;
    if (this.clientX === newClientX || isNaN(newClientX)) return;
    if (isNaN(this.clientX)) {
      this.clientX = this.newClientX;
      return;
    }

    const distance = newClientX - this.clientX;
    let width = window.getComputedStyle(this.element).width;
    if (!width.endsWith('px')) {
      throw 'Width is not in pixels';
    }
    width = parseInt(width);
    if (this.resizing)
      this.element.style.setProperty('width', `${width - distance}px`);

    this.clientX = newClientX;
  }

  doAnimationFrame(timestamp) {
    if (verbose) console.log('doAnimationFrame');
    this.doResize();
    if (this.resizing)
      window.requestAnimationFrame(this.boundDoAnimationFrame);
  }
}

function addResizeBarToSidepanel(sidepanel) {
  const resizeBar = document.createElement('div');
  resizeBar.id = 'sidepanel-resize-bar';
  sidepanel.insertBefore(resizeBar, sidepanel.firstElementChild);

  const resizer = new ResizeHelper(sidepanel, resizeBar);
  console.log('Added resize bar');
}

/**** INIT ****/

async function watchForSidepanel() {
  
  console.log('pmhaf -2');
  let intervalId = setInterval(() => {
    const sidepanel = document.querySelector('#side-panel');

    if (sidepanel && sidepanel.innerHTML) {
      clearInterval(intervalId);
      addResizeBarToSidepanel(sidepanel);
      createPrivateMessageToggleActivityFeed();
      new PrivateMessagesHiderSidepanel(sidepanel);
    }
  }, 100);
}

watchForSidepanel();
console.log('kantbotha.js loaded');