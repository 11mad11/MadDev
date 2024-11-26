# MadDev
This readme need to be updated. Below are the manual operation to use the main features of this program.

## Register a service
```
ssh -R <[[service name]]>:<[[service type]]>:<[[service addr]]>:<[[service port]]> -N <[[ssh gateway]]>
```

## Use a service
```
ssh -L <[[local port]]>:<[[service name]]>:<[[service type]]> -N <[[ssh gateway]]>
```

## SSH

### Server
```
ssh <[[ssh gateway]]> sshca > /etc/ssh/gateway_ca.pub
echo "TrustedUserCAKeys /etc/ssh/gateway_ca.pub" >> /etc/ssh/sshd_config
ssh -R <[[service name]]>:22:localhost:22 -N <[[ssh gateway]]>
```

### client
```
echo $(ssh <[[ssh gateway]]> signsshkey < ~/.ssh/id_rsa.pub) > ~/.ssh/id_rsa-cert.pub
ssh -L <[[local port]]>:<[[service name]]>:22 -N <[[ssh gateway]]>
ssh <[[user]]>@localhost -p <[[local port]]>
```
