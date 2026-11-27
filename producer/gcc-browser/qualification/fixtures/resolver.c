#include <arpa/nameser.h>
#include <stdio.h>

int main(void) {
    const unsigned char message[NS_HFIXEDSZ] = {0};
    ns_msg parsed;
    if (ns_initparse(message, sizeof(message), &parsed) != 0) return 1;
    printf("%d\n", ns_msg_count(parsed, ns_s_qd));
}
