/** The last destination at or before the reading position is the current section.
 *  For equal destinations, the later (nested) source bookmark is more specific. */
export function updateReaderToc(list, { sectionIndex, pdfPage } = {}) {
    const links = [...list.querySelectorAll('a')];
    const key = pdfPage == null ? 'sectionIndex' : 'pdfPage';
    const position = pdfPage == null ? sectionIndex : pdfPage;
    let active = null;
    let nearest = -1;
    for (const link of links) {
        const destination = Number(link.dataset[key]);
        if (link.dataset[key] != null && Number.isInteger(destination) &&
            destination <= position && destination >= nearest) {
            nearest = destination;
            active = link;
        }
    }
    for (const link of links) {
        link.classList.toggle('active', link === active);
        if (link === active) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
    }
    return active;
}
